import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { type Api, GrammyError } from 'grammy';
import { DownloadFailedError, FileTooLargeError, UserFacingError, errorMessage } from '../../errors/AppErrors.js';
import type { TempFileManager } from '../../utils/TempFileManager.js';

/**
 * Baixa anexos do Telegram para ./tmp via streaming.
 * Aborta após `idleTimeoutMs` sem receber bytes (EC-05) ou ao exceder `maxBytes`,
 * sempre removendo o arquivo parcial. A URL (que contém o token) nunca é logada.
 */
export class TelegramFileDownloader {
  constructor(
    private readonly api: Api,
    private readonly botToken: string,
    private readonly tmp: TempFileManager,
    private readonly idleTimeoutMs = 15_000,
  ) {}

  async download(fileId: string, extension: string, maxBytes: number): Promise<string> {
    const file = await this.api.getFile(fileId).catch((error: unknown) => {
      if (error instanceof GrammyError && /too big/i.test(error.description)) {
        throw new FileTooLargeError('Telegram recusou (file is too big)');
      }
      throw new DownloadFailedError(`getFile: ${errorMessage(error)}`, error);
    });
    if (!file.file_path) throw new DownloadFailedError('getFile sem file_path');
    if (file.file_size && file.file_size > maxBytes) throw new FileTooLargeError(`${file.file_size} bytes`);

    const target = this.tmp.createPath(extension);
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    const resetTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    };

    try {
      const response = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`, {
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new DownloadFailedError(`HTTP ${response.status}`);

      let received = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          resetTimer();
          received += chunk.length;
          if (received > maxBytes) callback(new FileTooLargeError(`${received}+ bytes`));
          else callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        guard,
        fs.createWriteStream(target),
        { signal: controller.signal },
      );
      return target;
    } catch (error) {
      await this.tmp.remove(target);
      if (error instanceof UserFacingError) throw error;
      if (controller.signal.aborted) {
        throw new DownloadFailedError(`sem bytes recebidos por ${this.idleTimeoutMs}ms`, error);
      }
      throw new DownloadFailedError(errorMessage(error), error);
    } finally {
      clearTimeout(timer);
    }
  }
}
