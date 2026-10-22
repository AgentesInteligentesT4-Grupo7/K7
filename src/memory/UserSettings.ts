import type { SqliteDatabase } from './DatabaseConnection.js';

/** Preferências por usuário que sobrevivem a reinícios (spec personas-styles §5.3): persona e estilo ativos. */
export class UserSettings {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, key)
      );
    `);
  }

  get(userId: string, key: string): string | undefined {
    return this.db.prepare<[string, string], { value: string }>('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key)?.value;
  }

  set(userId: string, key: string, value: string | undefined): void {
    if (value === undefined) {
      this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
      return;
    }
    this.db
      .prepare("INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
      .run(userId, key, value);
  }
}
