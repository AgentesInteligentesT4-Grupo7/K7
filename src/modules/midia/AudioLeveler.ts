import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserFacingError, errorMessage } from '../../errors/AppErrors.js';

/** Extensões que o serviço nivela (o arquivo sai no mesmo formato; vídeo: só o áudio muda). */
export const LEVELABLE = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.mp4', '.mkv', '.webm', '.mov']);

export interface LevelResult {
  /** Volume medido antes, em LUFS (ex.: -23.9). */
  before: number | null;
  after: number | null;
}

/**
 * Nivelamento de volume (módulo midia) pelo serviço servicos/ytdlp, que tem o ffmpeg: todas as músicas no mesmo
 * volume percebido (EBU R128, padrão -14 LUFS das plataformas de música), sem distorcer.
 */
export class AudioLeveler {
  private slots?: Promise<number>;

  constructor(private readonly options: { baseUrl: string; timeoutMs: number }) {}

  /**
   * Quantas músicas o serviço nivela ao mesmo tempo (ele descobre pelos núcleos da máquina dele); quem manda
   * arquivos usa este número para não deixar núcleo parado nem formar fila à toa. Serviço fora do ar: 2.
   */
  parallel(): Promise<number> {
    this.slots ??= fetch(`${this.options.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) })
      .then((res) => res.json() as Promise<{ nivelar_paralelo?: number }>)
      .then((health) => Math.max(1, Number(health.nivelar_paralelo) || 2))
      .catch(() => {
        this.slots = undefined; // tenta de novo na próxima vez
        return 2;
      });
    return this.slots;
  }

  /** Envia o conteúdo e devolve a resposta do serviço (o arquivo nivelado), para repassar sem guardar. */
  levelStream(body: ReadableStream<Uint8Array> | Buffer, name: string, signal?: AbortSignal): Promise<Response> {
    return this.send('/nivelar', 'nivelar', body, name, signal);
  }

  /**
   * Padronização do nome ("Título - Artista", sem "(2)" nem "(Official Video)") e das etiquetas: a resposta traz o
   * nome novo nos cabeçalhos e, quando as etiquetas mudaram, o arquivo regravado (204 = só o nome pode mudar).
   */
  standardizeStream(body: ReadableStream<Uint8Array> | Buffer, name: string): Promise<Response> {
    return this.send('/padronizar', 'padronizar', body, name);
  }

  /**
   * Padroniza um arquivo do servidor no lugar. Se o nome padronizado já existir na pasta, é a mesma música:
   * o arquivo atual sai e fica o que já estava (`duplicate`).
   */
  async standardizeFile(file: string): Promise<{ from: string; to: string; duplicate: boolean }> {
    const response = await this.standardizeStream(Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>, file);
    const name = path.basename(decodeURIComponent(response.headers.get('x-nome') ?? '') || path.basename(file));
    const target = path.join(path.dirname(file), name);
    const same = path.resolve(target).toLowerCase() === path.resolve(file).toLowerCase();
    if (!same && fs.existsSync(target)) {
      await response.body?.cancel();
      fs.rmSync(file, { force: true });
      return { from: file, to: target, duplicate: true };
    }
    if (response.status !== 204 && response.body) {
      const temp = `${file}.padronizando`;
      try {
        await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(temp));
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    // Só muda maiúscula/minúscula no Windows: renomear direto não pega, então passa por um nome provisório.
    if (!same || path.basename(file) !== name) {
      const step = `${file}.renomeando`;
      fs.renameSync(file, step);
      fs.renameSync(step, target);
    }
    return { from: file, to: target, duplicate: false };
  }

  /** `signal`: quem pediu foi embora (fechou a página); o serviço percebe a conexão caindo e para o ffmpeg. */
  private async send(endpoint: string, verb: string, body: ReadableStream<Uint8Array> | Buffer, name: string, signal?: AbortSignal): Promise<Response> {
    if (!LEVELABLE.has(path.extname(name).toLowerCase())) throw new UserFacingError(`Formato ${path.extname(name) || '(sem extensão)'} não dá para ${verb}.`);
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${endpoint}?nome=${encodeURIComponent(path.basename(name))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as never,
        duplex: 'half',
        signal: signal ? AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs), signal]) : AbortSignal.timeout(this.options.timeoutMs),
      } as RequestInit);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new UserFacingError(`o serviço de downloads (que sabe ${verb}) não está no ar.`, errorMessage(error), { cause: error });
    }
    if (!response.ok) {
      const detail = ((await response.json().catch(() => ({}))) as { detail?: string }).detail;
      throw new UserFacingError(`Não consegui ${verb} "${path.basename(name)}": ${detail ?? `HTTP ${response.status}`}`);
    }
    return response;
  }

  /** Nivela o arquivo no lugar: grava a versão nova ao lado e só então troca (o original nunca fica pela metade). */
  async levelFile(file: string): Promise<LevelResult> {
    const response = await this.levelStream(Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>, file);
    const temp = `${file}.nivelando`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(temp));
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return AudioLeveler.volumes(response);
  }

  static volumes(response: Response): LevelResult {
    const read = (header: string) => {
      const value = Number(response.headers.get(header));
      return Number.isFinite(value) && response.headers.has(header) ? value : null;
    };
    return { before: read('x-volume-antes'), after: read('x-volume-depois') };
  }
}
