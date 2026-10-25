import fs from 'node:fs';
import path from 'node:path';
import type { GeneratedMedia } from '../../../../agent/ResponseAttachments.js';
import { Logger } from '../../../../utils/Logger.js';
import type { TelegramSender } from '../TelegramSender.js';
import type { IOutputStrategy } from './OutputStrategy.js';

/** Bots do Telegram só enviam arquivos de até 50 MB. */
export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/**
 * Áudios e vídeos produzidos pelas ferramentas (módulo midia): áudio vai como música, vídeo como vídeo.
 * Acima de 50 MB o Telegram recusa: avisa onde o arquivo ficou salvo no computador.
 */
export class MediaOutputStrategy implements IOutputStrategy<GeneratedMedia[]> {
  private readonly logger = new Logger('MediaOutput');

  constructor(
    private readonly sender: TelegramSender,
    private readonly notify: (chatId: number, text: string) => Promise<void>,
    private readonly maxBytes = TELEGRAM_MAX_UPLOAD_BYTES,
  ) {}

  async send(chatId: number, media: GeneratedMedia[]): Promise<void> {
    const tooBig: string[] = [];
    for (const item of media) {
      const size = fs.statSync(item.path).size;
      const name = path.basename(item.path);
      if (size > this.maxBytes) {
        tooBig.push(`- ${name} (${mb(size)}): ${item.path}`);
        continue;
      }
      if (item.kind === 'audio') await this.sender.sendAudio(chatId, item.path, name, item.caption);
      else if (item.kind === 'video') await this.sender.sendVideo(chatId, item.path, name, item.caption);
      else await this.sender.sendDocument(chatId, item.path, name, item.caption);
      this.logger.info(`📎 ${item.kind} enviado: ${name} (${mb(size)})`);
    }
    if (tooBig.length) {
      await this.notify(chatId, `📁 Grande demais para o Telegram (limite de 50 MB). Ficou salvo no computador:\n${tooBig.join('\n')}`);
    }
  }
}
