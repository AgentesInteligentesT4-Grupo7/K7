import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../utils/Logger.js';

export type SqliteDatabase = Database.Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    provider    TEXT NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user_active ON conversations (user_id, is_active);

  CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content          TEXT NOT NULL,
    metadata         TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, id);
`;

/**
 * Singleton da conexão SQLite. Cria o arquivo e as tabelas no startup (RF-01),
 * ativa WAL (RF-02) e um busy_timeout para esperar locks em vez de falhar (EC-02).
 * Foreign keys ficam desligadas por decisão de spec (referências programáticas).
 */
export class DatabaseConnection {
  private static instance: SqliteDatabase | undefined;
  private static readonly logger = new Logger('Database');

  private constructor() {}

  static getInstance(dbPath: string): SqliteDatabase {
    if (!DatabaseConnection.instance) {
      DatabaseConnection.instance = DatabaseConnection.open(dbPath);
      DatabaseConnection.logger.info(`SQLite pronto em ${path.relative(process.cwd(), dbPath) || dbPath} (WAL)`);
    }
    return DatabaseConnection.instance;
  }

  /** Abre uma conexão independente (usado em testes com ':memory:'). */
  static open(dbPath: string): SqliteDatabase {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = OFF');
    db.exec(SCHEMA);
    return db;
  }

  static close(): void {
    if (DatabaseConnection.instance?.open) {
      DatabaseConnection.instance.close();
      DatabaseConnection.logger.info('Conexão SQLite encerrada');
    }
    DatabaseConnection.instance = undefined;
  }
}
