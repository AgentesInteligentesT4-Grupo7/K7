import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';

/** Fita que aparece no site (perfil.yaml com `vitrine: true`). */
export interface ShowcaseTape {
  nome: string;
  titulo: string;
  emoji: string;
  descricao: string;
}

/** Chat de uma fita rodando atrás do site. */
export interface RunningTape {
  port: number;
  stop(): void;
  /** Avisa quando o processo da fita termina (ex.: caiu). */
  onExit(listener: () => void): void;
}

export interface SiteOptions {
  host: string;
  port: number;
  /** Primeira porta (só 127.0.0.1) dos chats das fitas; cada fita usa a seguinte. */
  tapeBasePort: number;
  /** Fitas liberadas (lidas a cada pedido: liberar uma fita não exige reiniciar o site). */
  listTapes: () => ShowcaseTape[];
  /** Liga o chat de uma fita na porta dada (padrão: `npm run web -- --perfil <nome> --atras-do-site`). */
  launch?: (nome: string, port: number) => RunningTape;
  /** Espera máxima até o chat da fita responder. */
  startTimeoutMs?: number;
  /**
   * Domínio do site (ex.: exemplo.com.br, com um curinga *.exemplo.com.br no túnel): cada fita da vitrine abre também
   * em <fita>.exemplo.com.br, sem configurar nada por fita; www volta para o domínio.
   */
  dominio?: string;
}

const PAGE = fileURLToPath(new URL('../../../web/site.html', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TAPE_PATH = /^\/fita\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/;
const TAPE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Site do K7: escolhe a fita (só as liberadas) e repassa o chat dela pelo mesmo endereço (`/fita/<nome>/`).
 * Cada fita roda no próprio processo, só em 127.0.0.1 e sempre no modo público (visitantes isolados, limites);
 * o processo é ligado no primeiro acesso e desligado junto com o site.
 */
export class SiteServer {
  private readonly logger = new Logger('Site');
  private server?: http.Server;
  private readonly running = new Map<string, { tape: RunningTape; ready: Promise<void> }>();
  private readonly ports = new Map<string, number>();

  constructor(private readonly options: SiteOptions) {}

  get url(): string {
    const host = ['0.0.0.0', '::'].includes(this.options.host) ? '127.0.0.1' : this.options.host;
    return `http://${host}:${this.address?.port ?? this.options.port}/`;
  }

  get address(): { port: number } | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address : undefined;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    // Respostas de LLM e downloads de playlist podem levar minutos.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host, () => resolve());
    });
    this.logger.info(`📼 Site do K7: ${this.url} (${this.options.listTapes().length} fita(s) na vitrine)`);
  }

  async stop(): Promise<void> {
    for (const { tape } of this.running.values()) tape.stop();
    this.running.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const sub = this.subdominio(req);
      if (sub === 'www') return void res.writeHead(301, { location: `https://${this.options.dominio}${url.pathname}${url.search}` }).end();
      // <fita>.dominio: o chat da fita na raiz do endereço (fora da vitrine: 404).
      if (sub) return this.proxy(req, res, await this.ensure(sub), `${url.pathname}${url.search}`);
      if (req.method === 'GET' && url.pathname === '/') return this.sendPage(res);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return void res.writeHead(204).end();
      if (req.method === 'GET' && url.pathname === '/api/fitas') return this.json(res, this.options.listTapes());
      const play = /^\/api\/fitas\/([a-z0-9][a-z0-9-]{0,39})\/tocar$/.exec(url.pathname);
      if (req.method === 'POST' && play) {
        await this.ensure(play[1]!);
        return this.json(res, { ok: true, url: this.options.dominio ? `https://${play[1]}.${this.options.dominio}/` : `/fita/${play[1]}/` });
      }
      const tape = TAPE_PATH.exec(url.pathname);
      if (tape) {
        // Sem a barra final, os caminhos relativos da página quebrariam.
        if (!tape[2]) return void res.writeHead(301, { location: `/fita/${tape[1]}/${url.search}` }).end();
        const port = await this.ensure(tape[1]!);
        return this.proxy(req, res, port, `${tape[2]}${url.search}`);
      }
      this.json(res, { erro: 'Não encontrado' }, 404);
    } catch (error) {
      const status = error instanceof SiteError ? error.status : 502;
      if (status === 502) this.logger.error(`Falha no site: ${errorMessage(error)}`);
      if (!res.headersSent) this.json(res, { erro: error instanceof SiteError ? error.message : 'A fita não respondeu; tente de novo.' }, status);
      else res.destroy();
    }
  }

  /** "agrominds" em agrominds.<dominio> (Host do pedido); undefined no próprio domínio ou sem SITE_DOMINIO. */
  private subdominio(req: http.IncomingMessage): string | undefined {
    const dominio = this.options.dominio;
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!dominio || !host.endsWith(`.${dominio}`)) return undefined;
    const sub = host.slice(0, -dominio.length - 1);
    if (!TAPE_NAME.test(sub)) throw new SiteError(404, 'Endereço não encontrado.');
    return sub;
  }

  /**
   * Porta fixa por fita enquanto o site roda. Não pela posição na vitrine: liberar uma fita nova mudaria a posição das
   * outras, e a nova cairia na porta de uma fita já ligada (abrindo o chat errado).
   */
  private portFor(nome: string): number {
    if (!this.ports.has(nome)) this.ports.set(nome, this.options.tapeBasePort + this.ports.size);
    return this.ports.get(nome)!;
  }

  /** Liga o chat da fita (uma vez) e espera ele responder; devolve a porta. */
  private async ensure(nome: string): Promise<number> {
    if (!this.options.listTapes().some((t) => t.nome === nome)) throw new SiteError(404, 'Essa fita não está disponível no site.');
    let entry = this.running.get(nome);
    if (!entry) {
      const port = this.portFor(nome);
      const tape = (this.options.launch ?? launchTape)(nome, port);
      tape.onExit(() => {
        if (this.running.get(nome)?.tape === tape) this.running.delete(nome);
        this.logger.warn(`📼 Fita "${nome}" parou`);
      });
      entry = { tape, ready: waitUntilUp(port, this.options.startTimeoutMs ?? 90_000) };
      this.running.set(nome, entry);
      this.logger.info(`📼 Fita "${nome}" encaixada (porta interna ${port})`);
      entry.ready.catch(() => {
        tape.stop();
        this.running.delete(nome);
      });
    }
    await entry.ready;
    return entry.tape.port;
  }

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, port: number, target: string): Promise<void> {
    return new Promise((resolve) => {
      const upstream = http.request(
        { host: '127.0.0.1', port, method: req.method, path: target, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
          response.on('end', resolve);
        },
      );
      upstream.on('error', (error) => {
        this.logger.warn(`Repasse para a fita falhou: ${errorMessage(error)}`);
        if (!res.headersSent) this.json(res, { erro: 'A fita não respondeu; tente de novo.' }, 502);
        else res.destroy();
        resolve();
      });
      req.pipe(upstream);
    });
  }

  private sendPage(res: http.ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'`,
    });
    res.end(fs.readFileSync(PAGE, 'utf8').replaceAll('__NONCE__', nonce));
  }

  private json(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
}

class SiteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Espera o chat da fita responder na porta (o processo leva alguns segundos para subir). */
async function waitUntilUp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      http
        .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        })
        .on('error', () => resolve(false));
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new SiteError(504, 'A fita demorou demais para começar; tente de novo.');
}

/** `npm run web -- --perfil <nome> --porta <n> --atras-do-site`, com o log da fita repassado ao do site. */
function launchTape(nome: string, port: number): RunningTape {
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const built = path.join(ROOT, 'dist', 'canais', 'web', 'web.js');
  const args = fs.existsSync(tsx)
    ? [tsx, path.join(ROOT, 'src', 'canais', 'web', 'web.ts')]
    : [built];
  const child: ChildProcess = spawn(process.execPath, [...args, '--perfil', nome, '--porta', String(port), '--atras-do-site'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logger = new Logger(`fita:${nome}`);
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) logger.info(line.replace(/\x1b\[[0-9;]*m/g, ''));
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  return {
    port,
    stop: () => {
      if (child.exitCode === null) child.kill();
    },
    onExit: (listener) => child.once('exit', listener),
  };
}
