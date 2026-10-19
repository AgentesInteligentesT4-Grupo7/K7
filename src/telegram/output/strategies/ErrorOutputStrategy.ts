import { AllProvidersFailedError, UserFacingError } from '../../../errors/AppErrors.js';
import type { TelegramSender } from '../TelegramSender.js';
import type { IOutputStrategy } from './OutputStrategy.js';

/**
 * Avisos de erro com emoji amarelo. Nunca repassa stack traces ou detalhes
 * técnicos (que podem conter dados sensíveis) — apenas a mensagem amigável.
 */
export class ErrorOutputStrategy implements IOutputStrategy<unknown> {
  constructor(private readonly sender: TelegramSender) {}

  async send(chatId: number, error: unknown): Promise<void> {
    await this.sender.sendText(chatId, ErrorOutputStrategy.format(error));
  }

  static format(error: unknown): string {
    if (error instanceof AllProvidersFailedError) return `⚠️ Erro: ${error.userMessage}`;
    if (error instanceof UserFacingError) return `⚠️ ${error.userMessage}`;
    return '⚠️ Erro: ocorreu uma falha interna ao processar sua mensagem. Veja os logs do terminal.';
  }
}
