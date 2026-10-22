import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../../memory/DatabaseConnection.js';

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'other';

export interface Attachment {
  id: number;
  userId: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  /** Relativo à pasta de anexos. */
  path: string;
  sizeBytes: number;
  sha256: string;
  caption: string;
  extractedChars: number;
  createdAt: string;
}

export interface AttachmentPart {
  label: string;
  /** Origem do texto: camada de texto, ocr:visao... */
  source: string;
  text: string;
}

interface AttachmentRow {
  id: number;
  user_id: string;
  kind: AttachmentKind;
  original_name: string;
  mime: string;
  path: string;
  size_bytes: number;
  sha256: string;
  caption: string | null;
  extracted_chars: number;
  created_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    caption TEXT,
    extracted_chars INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_user_sha ON attachments (user_id, sha256);
  CREATE TABLE IF NOT EXISTS attachment_texts (
    attachment_id INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    part_label TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (attachment_id, part_index)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS attachments_fts USING fts5(
    text, attachment_id UNINDEXED, part_label UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
  );
`;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.html', '.htm', '.xml', '.log']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.xml': 'text/xml', '.log': 'text/plain',
};

/** MIME pela extensão quando o canal não informa (terminal). */
export function mimeOf(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function kindOf(name: string, mime = ''): AttachmentKind {
  const ext = path.extname(name).toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext) || mime === 'application/json') return 'text';
  return 'other';
}

/**
 * Biblioteca de anexos (spec attachments RF-02, RF-11): arquivo em disco + registro no SQLite +
 * texto extraído com busca FTS5. Cada usuário só enxerga os próprios anexos.
 */
export class AttachmentStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly dir: string,
  ) {
    db.exec(SCHEMA);
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Salva (ou reaproveita, se o mesmo arquivo já foi enviado) e devolve o anexo. */
  save(input: { userId: string; name: string; mime: string; data: Buffer; caption?: string }): { attachment: Attachment; duplicate: boolean } {
    const sha256 = createHash('sha256').update(input.data).digest('hex');
    const mime = input.mime || mimeOf(input.name);
    const existing = this.db
      .prepare<[string, string], AttachmentRow>('SELECT * FROM attachments WHERE user_id = ? AND sha256 = ?')
      .get(input.userId, sha256);
    if (existing) return { attachment: AttachmentStore.map(existing), duplicate: true };

    const month = new Date().toISOString().slice(0, 7);
    const safeUser = input.userId.replace(/[^\w-]/g, '_');
    const safeName = path.basename(input.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '-').slice(-120) || 'arquivo';
    const relative = path.join(safeUser, month, `${sha256.slice(0, 12)}-${safeName}`);
    fs.mkdirSync(path.dirname(path.join(this.dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, relative), input.data);

    const result = this.db
      .prepare('INSERT INTO attachments (user_id, kind, original_name, mime, path, size_bytes, sha256, caption) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.userId, kindOf(input.name, mime), input.name, mime, relative, input.data.length, sha256, input.caption ?? null);
    return { attachment: this.get(input.userId, Number(result.lastInsertRowid))!, duplicate: false };
  }

  setText(id: number, parts: AttachmentPart[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM attachment_texts WHERE attachment_id = ?').run(id);
      this.db.prepare('DELETE FROM attachments_fts WHERE attachment_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO attachment_texts (attachment_id, part_index, part_label, source, text) VALUES (?, ?, ?, ?, ?)');
      const fts = this.db.prepare('INSERT INTO attachments_fts (text, attachment_id, part_label) VALUES (?, ?, ?)');
      parts.forEach((part, i) => {
        insert.run(id, i, part.label, part.source, part.text);
        fts.run(part.text, id, part.label);
      });
      const chars = parts.reduce((sum, p) => sum + p.text.length, 0);
      this.db.prepare('UPDATE attachments SET extracted_chars = ? WHERE id = ?').run(chars, id);
    })();
  }

  get(userId: string, id: number): Attachment | undefined {
    const row = this.db.prepare<[number, string], AttachmentRow>('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(id, userId);
    return row ? AttachmentStore.map(row) : undefined;
  }

  list(userId: string, options: { kind?: AttachmentKind; name?: string; limit?: number } = {}): Attachment[] {
    const where = ['user_id = ?'];
    const params: unknown[] = [userId];
    if (options.kind) (where.push('kind = ?'), params.push(options.kind));
    if (options.name) (where.push('(original_name LIKE ? OR caption LIKE ?)'), params.push(`%${options.name}%`, `%${options.name}%`));
    params.push(options.limit ?? 20);
    return this.db
      .prepare<unknown[], AttachmentRow>(`SELECT * FROM attachments WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...params)
      .map(AttachmentStore.map);
  }

  texts(id: number): AttachmentPart[] {
    return this.db
      .prepare<[number], { part_label: string; source: string; text: string }>('SELECT part_label, source, text FROM attachment_texts WHERE attachment_id = ? ORDER BY part_index')
      .all(id)
      .map((r) => ({ label: r.part_label, source: r.source, text: r.text }));
  }

  /** Busca por palavras no texto extraído (FTS5, sem diferenciar acentos). */
  search(userId: string, term: string, limit = 10): Array<{ attachment: Attachment; label: string; snippet: string }> {
    const query = term
      .split(/\s+/)
      .map((w) => w.replace(/["*^():]/g, ''))
      .filter(Boolean)
      .map((w) => `"${w}"`)
      .join(' ');
    if (!query) return [];
    const rows = this.db
      .prepare<[string, string, number], { attachment_id: number; part_label: string; snippet: string }>(
        `SELECT f.attachment_id, f.part_label, snippet(attachments_fts, 0, '«', '»', '…', 24) AS snippet
           FROM attachments_fts f JOIN attachments a ON a.id = f.attachment_id
          WHERE attachments_fts MATCH ? AND a.user_id = ? ORDER BY rank LIMIT ?`,
      )
      .all(query, userId, limit);
    return rows.map((r) => ({ attachment: this.get(userId, r.attachment_id)!, label: r.part_label, snippet: r.snippet })).filter((r) => r.attachment);
  }

  readFile(attachment: Attachment): Buffer {
    return fs.readFileSync(path.join(this.dir, attachment.path));
  }

  remove(userId: string, id: number): boolean {
    const attachment = this.get(userId, id);
    if (!attachment) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM attachment_texts WHERE attachment_id = ?').run(id);
      this.db.prepare('DELETE FROM attachments_fts WHERE attachment_id = ?').run(id);
      this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    })();
    fs.rmSync(path.join(this.dir, attachment.path), { force: true });
    return true;
  }

  /** Retenção (RF-11): remove anexos mais velhos que `days` e, se passar da cota, os mais antigos primeiro. */
  cleanup(days: number, maxBytes: number): number {
    let removed = 0;
    const old = this.db
      .prepare<[string], { id: number; user_id: string }>("SELECT id, user_id FROM attachments WHERE created_at < datetime('now', ?)")
      .all(`-${days} days`);
    for (const row of old) removed += Number(this.remove(row.user_id, row.id));
    let total = this.db.prepare<[], { total: number | null }>('SELECT SUM(size_bytes) AS total FROM attachments').get()?.total ?? 0;
    const oldest = this.db.prepare<[], { id: number; user_id: string; size_bytes: number }>('SELECT id, user_id, size_bytes FROM attachments ORDER BY id').all();
    for (const row of oldest) {
      if (total <= maxBytes) break;
      if (this.remove(row.user_id, row.id)) (removed++, (total -= row.size_bytes));
    }
    return removed;
  }

  private static map(row: AttachmentRow): Attachment {
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      name: row.original_name,
      mime: row.mime,
      path: row.path,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      caption: row.caption ?? '',
      extractedChars: row.extracted_chars,
      createdAt: row.created_at,
    };
  }
}
