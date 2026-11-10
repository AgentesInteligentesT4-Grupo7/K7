/** Resposta guardada de um pedido: o que a rota responderia direto (status HTTP e corpo JSON). */
export interface PendingResult {
  status: number;
  data: unknown;
}

interface Entry {
  userId: string;
  result?: PendingResult;
  finished: Promise<void>;
  lastSeen: number;
  abort: AbortController;
}

export interface PendingRequestsOptions {
  /** Quanto tempo a resposta pronta fica guardada esperando a página buscar (padrão 30 min). */
  keepMs?: number;
  /** Sem a página perguntar por este tempo, o pedido é dado como abandonado e o sinal dispara (padrão 5 min). */
  abandonMs?: number;
}

/**
 * Pedidos longos do chat web (mensagem ao agente, playlist inteira, nivelar). A página manda o pedido com um id
 * próprio (X-Pedido), recebe 202 na hora e vai perguntando pela resposta em GET /api/pedidos/<id>, cada pergunta
 * esperando no máximo alguns segundos. Assim nenhuma conexão fica aberta por minutos: proxies como o Cloudflare
 * cortam em 100 s (erro 524) e a resposta se perdia, embora o trabalho continuasse.
 *
 * O id vem da página para ela poder repetir o envio se a rede falhar sem criar um segundo pedido.
 */
export class PendingRequests {
  private readonly entries = new Map<string, Entry>();
  private readonly keepMs: number;
  private readonly abandonMs: number;
  private readonly timer: NodeJS.Timeout;

  constructor(options: PendingRequestsOptions = {}) {
    this.keepMs = options.keepMs ?? 30 * 60_000;
    this.abandonMs = options.abandonMs ?? 5 * 60_000;
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }

  static validId(id: unknown): id is string {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
  }

  /** Já existe (repetição do mesmo envio): não começa de novo. */
  has(userId: string, id: string): boolean {
    return this.entries.has(this.key(userId, id));
  }

  /** Começa o trabalho. O sinal dispara se a página parar de perguntar (fechou a aba). */
  start(userId: string, id: string, run: (abandoned: AbortSignal) => Promise<PendingResult>): void {
    const key = this.key(userId, id);
    if (this.entries.has(key)) return;
    const abort = new AbortController();
    const entry: Entry = { userId, lastSeen: Date.now(), abort, finished: Promise.resolve() };
    entry.finished = Promise.resolve()
      .then(() => run(abort.signal))
      .catch((error: unknown) => ({ status: 500, data: { erro: error instanceof Error ? error.message : String(error) } }))
      .then((result) => {
        entry.result = result;
        entry.lastSeen = Date.now();
      });
    this.entries.set(key, entry);
  }

  /**
   * Espera a resposta por até `waitMs`. undefined = pedido desconhecido (expirou ou o servidor reiniciou);
   * null = ainda trabalhando; senão, a resposta (entregue uma vez só).
   */
  async wait(userId: string, id: string, waitMs: number): Promise<PendingResult | null | undefined> {
    const key = this.key(userId, id);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.lastSeen = Date.now();
    if (!entry.result) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([entry.finished, new Promise<void>((resolve) => (timeout = setTimeout(resolve, waitMs)))]);
      clearTimeout(timeout);
    }
    entry.lastSeen = Date.now();
    if (!entry.result) return null;
    this.entries.delete(key);
    return entry.result;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private key(userId: string, id: string): string {
    return `${userId}\n${id}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.result && now - entry.lastSeen > this.keepMs) this.entries.delete(key);
      else if (!entry.result && !entry.abort.signal.aborted && now - entry.lastSeen > this.abandonMs) entry.abort.abort();
    }
  }
}
