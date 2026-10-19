import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './DatabaseConnection.js';

export interface Conversation {
  id: string;
  userId: string;
  provider: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ConversationRow {
  id: string;
  user_id: string;
  provider: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

/** Acesso à tabela `conversations` (Repository Pattern). */
export class ConversationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findActiveByUser(userId: string): Conversation | undefined {
    const row = this.db
      .prepare<[string], ConversationRow>(
        'SELECT * FROM conversations WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC, rowid DESC LIMIT 1',
      )
      .get(userId);
    return row ? ConversationRepository.map(row) : undefined;
  }

  findById(id: string): Conversation | undefined {
    const row = this.db.prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?').get(id);
    return row ? ConversationRepository.map(row) : undefined;
  }

  create(userId: string, provider: string): Conversation {
    const id = randomUUID();
    this.db.prepare('INSERT INTO conversations (id, user_id, provider) VALUES (?, ?, ?)').run(id, userId, provider);
    return this.findById(id)!;
  }

  deactivateAllForUser(userId: string): number {
    return this.db
      .prepare("UPDATE conversations SET is_active = 0, updated_at = datetime('now') WHERE user_id = ? AND is_active = 1")
      .run(userId).changes;
  }

  touch(id: string, provider?: string): void {
    if (provider) {
      this.db.prepare("UPDATE conversations SET updated_at = datetime('now'), provider = ? WHERE id = ?").run(provider, id);
    } else {
      this.db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(id);
    }
  }

  private static map(row: ConversationRow): Conversation {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
