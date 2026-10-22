import { TextChunker } from '../TextChunker.js';
import type { TelegramSender } from '../TelegramSender.js';
import type { IOutputStrategy } from './OutputStrategy.js';

/** Texto puro, fatiado em bolhas de até 4096 caracteres e enviado em ordem estrita. */
export class TextOutputStrategy implements IOutputStrategy<string> {
  constructor(
    private readonly sender: TelegramSender,
    private readonly chunker = new TextChunker(4096),
  ) {}

  async send(chatId: number, text: string): Promise<void> {
    // RNF-01: for...of sequencial (nunca Promise.all/map) para preservar a ordem cronológica.
    for (const chunk of this.chunker.split(text)) {
      await this.sender.sendText(chatId, chunk);
    }
  }
}
