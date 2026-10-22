import { errorMessage } from '../errors/AppErrors.js';
import type { ChatMessage } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';
import { sanitizeText, truncate } from '../utils/text.js';
import { type Conversation, ConversationRepository, type ConversationSummary } from './ConversationRepository.js';
import type { SqliteDatabase } from './DatabaseConnection.js';
import { buildHistory, memorySection } from './ContextBuilder.js';
import { type MessageRole, MessageRepository, type StoredMessage } from './MessageRepository.js';
import { SummaryRepository } from './SummaryRepository.js';

export interface MemoryOptions {
  /** Quantidade de mensagens recentes repassadas ao AgentLoop (MEMORY_WINDOW_SIZE). */
  windowSize: number;
  /** Limite de caracteres por mensagem persistida (EC-03). */
  maxMessageChars: number;
  /** Memória em camadas (spec memory v1.1). Ausente = comportamento v1.0 (janela fixa). */
  layered?: {
    compactThreshold: number;
    tokenBudget: number;
    factsEnabled: boolean;
  };
}

export interface BuiltContext {
  history: ChatMessage[];
  /** Resumo da conversa + fatos do usuário, para o system prompt (vazio se não houver). */
  memory: string;
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
  readonly summaries: SummaryRepository;

  constructor(
    db: SqliteDatabase,
    private readonly options: MemoryOptions,
  ) {
    this.conversations = new ConversationRepository(db);
    this.messages = new MessageRepository(db);
    this.summaries = new SummaryRepository(db);
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

  /**
   * Contexto em camadas (spec memory v1.1 RF-05): resumo + fatos no system prompt e, no histórico, as mensagens
   * ainda não resumidas (longas compactadas) dentro do orçamento. Sem resumo, usa a janela da v1.0 compactada.
   */
  buildContext(conversationId: string, userId: string): BuiltContext {
    const layered = this.options.layered;
    if (!layered) return { history: this.getContextWindow(conversationId), memory: '' };
    try {
      const summary = this.summaries.latest(conversationId);
      const facts = layered.factsEnabled ? this.summaries.facts(userId).map((f) => f.fact) : [];
      const pending = summary
        ? this.messages.findAfter(conversationId, summary.coversUntil, ['user', 'assistant'])
        : this.messages.findRecent(conversationId, this.options.windowSize, ['user', 'assistant']);
      const memory = memorySection(summary?.summary, facts);
      return { history: buildHistory(pending, memory, layered), memory };
    } catch (error) {
      this.logger.warn(`Falha ao montar a memória em camadas; usando a janela simples: ${errorMessage(error)}`);
      return { history: this.getContextWindow(conversationId), memory: '' };
    }
  }

  /** Mensagens user/assistant ainda não cobertas por resumo (entrada do ConversationSummarizer). */
  unsummarized(conversationId: string): StoredMessage[] {
    return this.messages.findAfter(conversationId, this.summaries.latest(conversationId)?.coversUntil ?? 0, ['user', 'assistant'], 500);
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

  listConversations(userId: string, limit = 50): ConversationSummary[] {
    return this.conversations.listByUser(userId, limit);
  }

  /** Reabre uma conversa antiga do próprio usuário (canal web). */
  activateConversation(userId: string, conversationId: string): boolean {
    return this.conversations.activate(userId, conversationId);
  }

  /** Histórico (user/assistant) de uma conversa do usuário, para exibir; vazio se não for dele. */
  getHistory(userId: string, conversationId: string, limit = 200): StoredMessage[] {
    if (this.conversations.findById(conversationId)?.userId !== userId) return [];
    return this.messages.findRecent(conversationId, limit, ['user', 'assistant']);
  }

  countMessages(conversationId: string): number {
    return this.messages.countByConversation(conversationId);
  }
}
