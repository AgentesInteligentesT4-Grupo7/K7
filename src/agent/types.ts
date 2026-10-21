export type InputSource = 'text' | 'document' | 'voice';
export type Channel = 'telegram' | 'terminal';

/** Entrada já normalizada em texto pelo TelegramInputHandler. */
export interface AgentInput {
  /** ID do usuário no canal (Telegram: numérico; terminal: "terminal"). */
  userId: number | string;
  /** Canal de origem (padrão: telegram). */
  channel?: Channel;
  chatId: number;
  text: string;
  source: InputSource;
  /** Marcador `requires_audio_reply` (spec telegram-input RF-06). */
  requiresAudioReply: boolean;
  voiceId?: string;
  attachmentName?: string;
}

/** Resultado final da pipeline, entregue ao TelegramOutputHandler. */
export interface AgentResponse {
  text: string;
  isAudio: boolean;
}

/** Contrato do Output Handler consumido pelo AgentController. */
export interface IOutputHandler {
  send(chatId: number, response: AgentResponse): Promise<void>;
  sendError(chatId: number, error: unknown): Promise<void>;
}
