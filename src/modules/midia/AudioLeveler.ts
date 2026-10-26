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
  constructor(private readonly options: { baseUrl: string; timeoutMs: number }) {}

  /** Envia o conteúdo e devolve a resposta do serviço (o arquivo nivelado), para repassar sem guardar. */
  async levelStream(body: ReadableStream<Uint8Array> | Buffer, name: string): Promise<Response> {
    if (!LEVELABLE.has(path.extname(name).toLowerCase())) throw new UserFacingError(`Formato ${path.extname(name) || '(sem extensão)'} não dá para nivelar.`);
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/nivelar?nome=${encodeURIComponent(path.basename(name))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: body as never,
        duplex: 'half',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      } as RequestInit);
    } catch (error) {
      throw new UserFacingError('o serviço de downloads (que nivela o volume) não está no ar.', errorMessage(error), { cause: error });
    }
    if (!response.ok) {
      const detail = ((await response.json().catch(() => ({}))) as { detail?: string }).detail;
      throw new UserFacingError(`Não consegui nivelar "${path.basename(name)}": ${detail ?? `HTTP ${response.status}`}`);
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
