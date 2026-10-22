import type { ImagePart } from '../llm/types.js';
import type { GeneratedImage } from './ResponseAttachments.js';

export type InputSource = 'text' | 'document' | 'voice' | 'image';
export type Channel = 'telegram' | 'terminal' | 'web';

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
  /** Imagens da mensagem atual (módulo anexos): vão ao LLM com visão junto do texto. */
  images?: ImagePart[];
}

/** Resultado final da pipeline, entregue ao TelegramOutputHandler. */
export interface AgentResponse {
  text: string;
  isAudio: boolean;
  /** Imagens geradas por ferramentas (módulo imagens), entregues pelo canal. */
  images?: GeneratedImage[];
}

/** Contexto extra recuperado para a mensagem (ex.: base de conhecimento no modo automático). */
export interface IContextProvider {
  contextFor(text: string): Promise<string | undefined>;
}

/** Contrato do Output Handler consumido pelo AgentController. */
export interface IOutputHandler {
  send(chatId: number, response: AgentResponse): Promise<void>;
  sendError(chatId: number, error: unknown): Promise<void>;
}
