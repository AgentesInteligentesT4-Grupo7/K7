import type { GeneratedImage } from '../../../../agent/ResponseAttachments.js';
import type { TelegramSender } from '../TelegramSender.js';
import type { IOutputStrategy } from './OutputStrategy.js';

/** Imagens geradas (módulo imagens): uma vira foto; várias, álbuns de até 10 (spec image-generation RF-11). */
export class ImageOutputStrategy implements IOutputStrategy<GeneratedImage[]> {
  constructor(private readonly sender: TelegramSender) {}

  async send(chatId: number, images: GeneratedImage[]): Promise<void> {
    for (let i = 0; i < images.length; i += 10) {
      const group = images.slice(i, i + 10);
      if (group.length === 1) await this.sender.sendPhoto(chatId, group[0]!.path, group[0]!.caption);
      else await this.sender.sendAlbum(chatId, group.map((image) => ({ filePath: image.path, caption: image.caption })));
    }
  }
}
