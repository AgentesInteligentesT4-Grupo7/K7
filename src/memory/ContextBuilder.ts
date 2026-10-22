import type { ChatMessage } from '../llm/types.js';
import type { StoredMessage } from './MessageRepository.js';

export interface ContextOptions {
  /** Resposta do assistente acima disso entra compactada (MEMORY_COMPACT_THRESHOLD). */
  compactThreshold: number;
  /** Orçamento estimado (caracteres / 4) para histórico + memória (MEMORY_TOKEN_BUDGET). */
  tokenBudget: number;
}

const estimate = (text: string) => Math.ceil(text.length / 4);

/**
 * Compactação no contexto (spec memory v1.1 RF-08): o original continua no banco.
 * `<arquivo nome="x">...</arquivo>` vira "[documento gerado: x]" e respostas longas viram início + marcador.
 */
export function compactMessage(message: StoredMessage, threshold: number): string {
  let text = message.content.replace(/<arquivo\s+nome="([^"]+)"[^>]*>[\s\S]*?<\/arquivo>/gi, '[documento gerado: $1]');
  if (message.role === 'assistant' && text.length > threshold) {
    text = `${text.slice(0, 400).trimEnd()}… [resposta longa compactada: ${message.content.length} caracteres, mensagem #${message.id}]`;
  }
  return text;
}

/**
 * Monta o histórico enviado ao LLM a partir das mensagens não resumidas, compactando as longas e
 * cortando as mais antigas até caber no orçamento — a última mensagem do usuário sempre inteira (EC-08).
 */
export function buildHistory(messages: StoredMessage[], memoryText: string, options: ContextOptions): ChatMessage[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const history = messages.map((m, i) => ({
    role: m.role as 'user' | 'assistant',
    content: i === lastUser ? m.content : compactMessage(m, options.compactThreshold),
  }));
  const budget = options.tokenBudget - estimate(memoryText);
  let total = history.reduce((sum, m) => sum + estimate(m.content), 0);
  while (history.length > 1 && total > budget) {
    total -= estimate(history.shift()!.content);
  }
  // Providers como o Gemini esperam que o histórico comece por uma mensagem do usuário.
  while (history.length > 1 && history[0]!.role !== 'user') history.shift();
  return history;
}

/** Bloco de memória que vai no system prompt: resumo da conversa + fatos do usuário. */
export function memorySection(summary: string | undefined, facts: string[]): string {
  const parts: string[] = [];
  if (summary?.trim()) parts.push(`# Memória da conversa (resumo das mensagens anteriores)\n${summary.trim()}`);
  if (facts.length) parts.push(`# Fatos sobre o usuário\n${facts.map((f) => `- ${f}`).join('\n')}`);
  return parts.join('\n\n');
}
