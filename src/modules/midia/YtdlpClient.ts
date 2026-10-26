import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserFacingError, errorMessage } from '../../errors/AppErrors.js';

export type MediaFormat = 'mp3' | 'wav' | 'mp4';

export interface DownloadRequest {
  url: string;
  /** Vários vídeos avulsos num só trabalho (vários links colados, ou tentar de novo os que falharam). */
  links?: string[];
  formato: MediaFormat;
  playlist: boolean;
  /** Ausente = a playlist inteira. */
  maxItens?: number;
  /** IDs dos vídeos (11 caracteres do link) já baixados neste formato: o serviço não baixa de novo. */
  pular?: string[];
}

export interface DownloadedFile {
  nome: string;
  /** ID do vídeo no YouTube. */
  id?: string;
  titulo?: string;
  bytes: number;
}

/** Vídeo pulado (excluído, privado, com restrição de idade, bloqueado...). */
export interface DownloadFailure {
  link: string | null;
  motivo: string;
}

export interface DownloadResult {
  /** Arquivos novos, copiados para a pasta, com o ID do vídeo de cada um. */
  files: Array<{ path: string; id?: string }>;
  failures: DownloadFailure[];
  /** IDs pedidos em `pular` que estavam no link: já existiam, não foram baixados. */
  skipped: string[];
  /** Nome da playlist (só em playlist). */
  title?: string;
  /** IDs na ordem original da playlist (os downloads em paralelo terminam fora de ordem). */
  order: string[];
}

interface Job {
  status: 'rodando' | 'ok' | 'erro';
  progresso: string;
  arquivos: DownloadedFile[];
  falhas?: DownloadFailure[];
  pulados?: string[];
  titulo?: string | null;
  ordem?: string[];
  erro: string | null;
}

export interface YtdlpOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Intervalo entre as consultas de andamento. */
  pollMs?: number;
}

/**
 * Cliente do serviço servicos/ytdlp: pede o download, acompanha até terminar, copia os arquivos
 * para a pasta de destino e apaga o trabalho no serviço.
 */
export class YtdlpClient {
  constructor(private readonly options: YtdlpOptions) {}

  /**
   * Pede o download e acompanha até terminar. Cada arquivo é copiado para `targetDir` assim que fica pronto
   * (`onUpdate` avisa a cada um, com os IDs pulados, o título e a ordem): a biblioteca cresce enquanto baixa.
   */
  async download(request: DownloadRequest, targetDir: string, onProgress?: (progress: string) => void, onUpdate?: (partial: DownloadResult) => void): Promise<DownloadResult> {
    const { id } = (await this.json('/baixar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: request.url,
        ...(request.links?.length ? { links: request.links } : {}),
        formato: request.formato,
        playlist: request.playlist,
        ...(request.maxItens ? { max_itens: request.maxItens } : {}),
        ...(request.pular?.length ? { pular: request.pular } : {}),
      }),
    })) as { id: string };
    const saved: DownloadResult['files'] = [];
    const copied = new Set<string>();
    const result = (job: Job): DownloadResult => ({
      files: [...saved],
      failures: job.falhas ?? [],
      skipped: job.pulados ?? [],
      ...(job.titulo ? { title: job.titulo } : {}),
      order: job.ordem ?? [],
    });
    // Copia os que ficaram prontos desde a última consulta.
    const collect = async (job: Job) => {
      let added = false;
      for (const file of job.arquivos) {
        if (copied.has(file.nome)) continue;
        fs.mkdirSync(targetDir, { recursive: true });
        saved.push({ path: await this.fetchFile(id, file.nome, file.bytes, targetDir), ...(file.id ? { id: file.id } : {}) });
        copied.add(file.nome);
        added = true;
      }
      if (added || job.status !== 'rodando') onUpdate?.(result(job));
    };
    try {
      const job = await this.wait(id, onProgress, collect);
      if (job.status === 'erro') {
        const links = (job.falhas ?? [])
          .filter((f) => f.link)
          .map((f) => `\n- ${f.link}: ${f.motivo}`)
          .join('');
        throw new UserFacingError(`Não consegui baixar: ${YtdlpClient.friendly(job.erro)}${links}`);
      }
      return result(job);
    } finally {
      await fetch(`${this.options.baseUrl}/trabalhos/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  async healthCheck(): Promise<string> {
    const health = (await this.json('/health', { method: 'GET' }, 5_000)) as { yt_dlp?: string };
    return health.yt_dlp ?? '?';
  }

  private async wait(id: string, onProgress?: (progress: string) => void, onPoll?: (job: Job) => Promise<void>): Promise<Job> {
    const deadline = Date.now() + this.options.timeoutMs;
    let last = '';
    for (;;) {
      const job = (await this.json(`/trabalhos/${id}`, { method: 'GET' })) as Job;
      if (job.progresso !== last) onProgress?.((last = job.progresso));
      await onPoll?.(job);
      if (job.status !== 'rodando') return job;
      if (Date.now() > deadline) throw new UserFacingError(`O download passou de ${Math.round(this.options.timeoutMs / 60_000)} min e foi interrompido (MIDIA_TIMEOUT_MS).`);
      await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 2_000));
    }
  }

  /** Copia o arquivo para a pasta; se já existir um com o mesmo nome, acrescenta " (2)", " (3)"... */
  private async fetchFile(id: string, name: string, bytes: number, targetDir: string): Promise<string> {
    const { name: base, ext } = path.parse(path.basename(name));
    let target = path.join(targetDir, `${base}${ext}`);
    // Mesma música já baixada antes (mesmo nome e tamanho): reaproveita em vez de criar "música (2).mp3".
    if (fs.existsSync(target) && fs.statSync(target).size === bytes) return target;
    const response = await fetch(`${this.options.baseUrl}/trabalhos/${id}/arquivos/${encodeURIComponent(name)}`);
    if (!response.ok || !response.body) throw new Error(`serviço ytdlp HTTP ${response.status} ao entregar "${name}"`);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(targetDir, `${base} (${i})${ext}`);
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(target));
    return target;
  }

  private async json(pathname: string, init: RequestInit, timeoutMs = 30_000): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new UserFacingError(
        `o serviço de downloads não está no ar (${this.options.baseUrl}). Suba com: docker compose -f servicos/ytdlp/docker-compose.yml up -d`,
        errorMessage(error),
        { cause: error },
      );
    }
    const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
    if (!response.ok) throw new UserFacingError(`o serviço de downloads recusou o pedido: ${String(body.detail ?? response.status)}`);
    return body;
  }

  /** Mensagens do yt-dlp que a pessoa entende. */
  static friendly(error: string | null): string {
    const text = error ?? 'erro desconhecido';
    if (/private video/i.test(text)) return 'o vídeo é privado.';
    if (/sign in to confirm your age|age-restricted/i.test(text)) return 'o vídeo tem restrição de idade (o YouTube pede login).';
    if (/unavailable|removed|does not exist/i.test(text)) return 'o vídeo está indisponível ou foi removido.';
    if (/not a bot|429|too many requests/i.test(text)) return 'o YouTube bloqueou temporariamente os downloads desta rede. Tente mais tarde.';
    return text.replace(/^ERROR:\s*/, '').slice(0, 300);
  }
}
