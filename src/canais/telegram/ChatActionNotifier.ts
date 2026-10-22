import type { ChatAction, TelegramSender } from './output/TelegramSender.js';

/**
 * Mantém o indicador "digitando..." / "gravando áudio..." ativo enquanto
 * a pipeline processa (o Telegram expira cada chat action em ~5s).
 */
export class ChatActionNotifier {
  constructor(
    private readonly sender: TelegramSender,
    private readonly intervalMs = 4_000,
  ) {}

  /** Inicia o indicador e retorna a função que o encerra. */
  start(chatId: number, action: ChatAction): () => void {
    void this.sender.sendChatAction(chatId, action);
    const timer = setInterval(() => void this.sender.sendChatAction(chatId, action), this.intervalMs);
    return () => clearInterval(timer);
  }
}
