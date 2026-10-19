import { errorMessage } from '../errors/AppErrors.js';
import type { ChatMessage } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';
import { sanitizeText, truncate } from '../utils/text.js';
import { type Conversation, ConversationRepository } from './ConversationRepository.js';
import type { SqliteDatabase } from './DatabaseConnection.js';
import { type MessageRole, MessageRepository } from './MessageRepository.js';

export interface MemoryOptions {
  /** Quantidade de mensagens recentes repassadas ao AgentLoop (MEMORY_WINDOW_SIZE). */
  windowSize: number;
  /** Limite de caracteres por mensagem persistida (EC-03). */
  maxMessageChars: number;
}

/**
 * Facade da memória: esconde repositórios e SQL do AgentLoop/Controller.
 * Persiste tudo, mas entrega ao LLM apenas a janela recente (truncamento nativo
 * sem apagar o histórico).
 */
export class MemoryManager {
  private readonly logger = new Logger('Memory');
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;

  constructor(
    db: SqliteDatabase,
    private readonly options: MemoryOptions,
  ) {
    this.conversations = new ConversationRepository(db);
    this.messages = new MessageRepository(db);
  }

  getOrCreateActiveConversation(userId: string, provider: string): Conversation {
    const existing = this.conversations.findActiveByUser(userId);
    if (existing) return existing;
    const created = this.conversations.create(userId, provider);
    this.logger.info(`Nova conversa ${created.id.slice(0, 8)} para o usuário ${userId}`);
    return created;
  }

  /** Arquiva a conversa ativa e abre outra (comando /nova). */
  startNewConversation(userId: string, provider: string): Conversation {
    this.conversations.deactivateAllForUser(userId);
    return this.getOrCreateActiveConversation(userId, provider);
  }

  /**
   * Persiste uma mensagem. Em caso de falha do banco (ex.: lock prolongado
   * além do busy_timeout) descarta de forma "soft" e retorna `false`.
   */
  saveMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    metadata?: Record<string, unknown>,
    provider?: string,
  ): boolean {
    try {
      const clean = truncate(sanitizeText(content), this.options.maxMessageChars);
      this.messages.insert({ conversationId, role, content: clean, metadata });
      this.conversations.touch(conversationId, provider);
      return true;
    } catch (error) {
      this.logger.warn(`Falha ao persistir mensagem (${role}); descartada: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Janela de contexto (somente user/assistant) pronta para o LLM. */
  getContextWindow(conversationId: string): ChatMessage[] {
    try {
      const recent = this.messages.findRecent(conversationId, this.options.windowSize, ['user', 'assistant']);
      // Providers como o Gemini esperam que o histórico comece por uma mensagem do usuário.
      while (recent.length > 0 && recent[0]!.role !== 'user') recent.shift();
      return recent.map((message) => ({ role: message.role, content: message.content }));
    } catch (error) {
      this.logger.warn(`Falha ao ler histórico; seguindo sem contexto: ${errorMessage(error)}`);
      return [];
    }
  }

  countMessages(conversationId: string): number {
    return this.messages.countByConversation(conversationId);
  }
}
