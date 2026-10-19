import type { SqliteDatabase } from './DatabaseConnection.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface StoredMessage {
  id: number;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  role: MessageRole;
  content: string;
  metadata: string | null;
  created_at: string;
}

/** Acesso à tabela `messages` (Repository Pattern). */
export class MessageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(message: NewMessage): number {
    const result = this.db
      .prepare('INSERT INTO messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)')
      .run(
        message.conversationId,
        message.role,
        message.content,
        message.metadata ? JSON.stringify(message.metadata) : null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Últimas `limit` mensagens dos papéis indicados, em ordem cronológica. */
  findRecent(conversationId: string, limit: number, roles: MessageRole[]): StoredMessage[] {
    const placeholders = roles.map(() => '?').join(', ');
    const rows = this.db
      .prepare<unknown[], MessageRow>(
        `SELECT * FROM messages WHERE conversation_id = ? AND role IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
      )
      .all(conversationId, ...roles, limit);
    return rows.reverse().map(MessageRepository.map);
  }

  countByConversation(conversationId: string): number {
    const row = this.db
      .prepare<[string], { total: number }>('SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?')
      .get(conversationId);
    return row?.total ?? 0;
  }

  private static map(row: MessageRow): StoredMessage {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      metadata,
      createdAt: row.created_at,
    };
  }
}
