import { type Api, GrammyError, HttpError, InputFile } from 'grammy';
import { BotBlockedError } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { sleep } from '../../utils/text.js';

export type ChatAction = 'typing' | 'record_voice' | 'upload_document';

/**
 * Wrapper sobre a API do grammy com política de envio resiliente:
 * - 429 Too Many Requests → dorme `retry_after` e re-dispara o mesmo payload (EC-01);
 * - 403 Forbidden → `BotBlockedError` (usuário bloqueou o bot, EC-03);
 * - falha de rede → poucas novas tentativas com backoff.
 */
export class TelegramSender {
  private readonly logger = new Logger('TelegramSender');

  constructor(
    private readonly api: Api,
    private readonly maxRetries = 5,
  ) {}

  sendText(chatId: number, text: string): Promise<unknown> {
    return this.call(chatId, () =>
      this.api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } }),
    );
  }

  sendDocument(chatId: number, filePath: string, filename: string, caption?: string): Promise<unknown> {
    return this.call(chatId, () => this.api.sendDocument(chatId, new InputFile(filePath, filename), { caption }));
  }

  sendVoice(chatId: number, filePath: string): Promise<unknown> {
    return this.call(chatId, () => this.api.sendVoice(chatId, new InputFile(filePath)));
  }

  /** Chat actions são "best effort": falhas são ignoradas. */
  async sendChatAction(chatId: number, action: ChatAction): Promise<void> {
    try {
      await this.api.sendChatAction(chatId, action);
    } catch {
      // sem impacto funcional
    }
  }

  private async call<T>(chatId: number, send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (error) {
        if (error instanceof GrammyError) {
          if (error.error_code === 429 && attempt < this.maxRetries) {
            const waitMs = (error.parameters.retry_after ?? 1) * 1000 + 250;
            this.logger.warn(`429 Too Many Requests — aguardando ${waitMs}ms antes de reenviar`);
            await sleep(waitMs);
            continue;
          }
          if (error.error_code === 403) throw new BotBlockedError(chatId);
        }
        if (error instanceof HttpError && attempt < 2) {
          this.logger.warn(`Falha de rede ao enviar (tentativa ${attempt + 1}); repetindo...`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
  }
}
