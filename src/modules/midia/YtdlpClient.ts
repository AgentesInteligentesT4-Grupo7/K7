import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserFacingError, errorMessage } from '../../errors/AppErrors.js';

export type MediaFormat = 'mp3' | 'wav' | 'mp4';

export interface DownloadRequest {
  url: string;
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
}

interface Job {
  status: 'rodando' | 'ok' | 'erro';
  progresso: string;
  arquivos: DownloadedFile[];
  falhas?: DownloadFailure[];
  pulados?: string[];
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

  async download(request: DownloadRequest, targetDir: string, onProgress?: (progress: string) => void): Promise<DownloadResult> {
    const { id } = (await this.json('/baixar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: request.url,
        formato: request.formato,
        playlist: request.playlist,
        ...(request.maxItens ? { max_itens: request.maxItens } : {}),
        ...(request.pular?.length ? { pular: request.pular } : {}),
      }),
    })) as { id: string };
    try {
      const job = await this.wait(id, onProgress);
      const failures = job.falhas ?? [];
      if (job.status === 'erro') {
        const links = failures
          .filter((f) => f.link)
          .map((f) => `\n- ${f.link}: ${f.motivo}`)
          .join('');
        throw new UserFacingError(`Não consegui baixar: ${YtdlpClient.friendly(job.erro)}${links}`);
      }
      fs.mkdirSync(targetDir, { recursive: true });
      const saved: DownloadResult['files'] = [];
      for (const file of job.arquivos) {
        saved.push({ path: await this.fetchFile(id, file.nome, file.bytes, targetDir), ...(file.id ? { id: file.id } : {}) });
      }
      return { files: saved, failures, skipped: job.pulados ?? [] };
    } finally {
      await fetch(`${this.options.baseUrl}/trabalhos/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  async healthCheck(): Promise<string> {
    const health = (await this.json('/health', { method: 'GET' }, 5_000)) as { yt_dlp?: string };
    return health.yt_dlp ?? '?';
  }

  private async wait(id: string, onProgress?: (progress: string) => void): Promise<Job> {
    const deadline = Date.now() + this.options.timeoutMs;
    let last = '';
    for (;;) {
      const job = (await this.json(`/trabalhos/${id}`, { method: 'GET' })) as Job;
      if (job.progresso !== last) onProgress?.((last = job.progresso));
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
