import type { SqliteDatabase } from './DatabaseConnection.js';

export interface ConversationSummary {
  id: number;
  conversationId: string;
  summary: string;
  /** Última mensagem coberta pelo resumo. */
  coversUntil: number;
  createdAt: string;
}

export interface UserFact {
  id: number;
  userId: string;
  fact: string;
  createdAt: string;
}

/** Resumos incrementais das conversas e fatos duradouros dos usuários (spec memory v1.1 §9). */
export class SummaryRepository {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        covers_until_message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON conversation_summaries (conversation_id, id);
      CREATE TABLE IF NOT EXISTS user_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        source_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_user_facts_user ON user_facts (user_id, id);
    `);
  }

  /** A versão vigente é a de maior id; as anteriores ficam como histórico. */
  latest(conversationId: string): ConversationSummary | undefined {
    const row = this.db
      .prepare<[string], { id: number; conversation_id: string; summary: string; covers_until_message_id: number; created_at: string }>(
        'SELECT * FROM conversation_summaries WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(conversationId);
    return row
      ? { id: row.id, conversationId: row.conversation_id, summary: row.summary, coversUntil: row.covers_until_message_id, createdAt: row.created_at }
      : undefined;
  }

  save(conversationId: string, summary: string, coversUntil: number): void {
    this.db.prepare('INSERT INTO conversation_summaries (conversation_id, summary, covers_until_message_id) VALUES (?, ?, ?)').run(conversationId, summary, coversUntil);
  }

  /** `/esquecer tudo`: o resumo deixa de valer (marcador vazio cobrindo o mesmo ponto). */
  clear(conversationId: string): void {
    const current = this.latest(conversationId);
    if (current) this.save(conversationId, '', current.coversUntil);
  }

  facts(userId: string): UserFact[] {
    return this.db
      .prepare<[string], { id: number; user_id: string; fact: string; created_at: string }>('SELECT * FROM user_facts WHERE user_id = ? ORDER BY id')
      .all(userId)
      .map((r) => ({ id: r.id, userId: r.user_id, fact: r.fact, createdAt: r.created_at }));
  }

  /** Lista completa e atualizada de fatos (o resumidor já resolve contradições). */
  replaceFacts(userId: string, facts: string[], sourceMessageId: number): void {
    const current = new Map(this.facts(userId).map((f) => [f.fact, f]));
    this.db.transaction(() => {
      for (const fact of current.values()) if (!facts.includes(fact.fact)) this.db.prepare('DELETE FROM user_facts WHERE id = ?').run(fact.id);
      for (const fact of facts) {
        if (!current.has(fact)) this.db.prepare('INSERT INTO user_facts (user_id, fact, source_message_id) VALUES (?, ?, ?)').run(userId, fact, sourceMessageId);
      }
    })();
  }

  removeFact(userId: string, position: number): string | undefined {
    const fact = this.facts(userId)[position - 1];
    if (!fact) return undefined;
    this.db.prepare('DELETE FROM user_facts WHERE id = ?').run(fact.id);
    return fact.fact;
  }

  clearFacts(userId: string): void {
    this.db.prepare('DELETE FROM user_facts WHERE user_id = ?').run(userId);
  }
}
