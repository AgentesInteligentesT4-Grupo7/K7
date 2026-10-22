import type { SqliteDatabase } from '../../memory/DatabaseConnection.js';

export interface KnowledgeDocument {
  id: number;
  /** "fita:receitas/bolo.md" ou "usuario:anotacoes/x.md": raiz + caminho relativo. */
  key: string;
  base: string;
  mtimeMs: number;
  size: number;
  chunks: number;
}

export interface KnowledgeChunk {
  id: number;
  docKey: string;
  base: string;
  ord: number;
  text: string;
}

const STOPWORDS = new Set(
  'a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela para pra com sem sobre entre e ou que se como qual quais quando onde porque é ser são foi era ao aos à às me te lhe meu minha seu sua isso isto esse essa este esta the of and to in is for on'.split(' '),
);

/**
 * Termos da consulta para o FTS5: sem pontuação especial nem palavras vazias, unidos por OR.
 * Termos com 4+ letras viram prefixo ("troca" acha "trocas" e "trocados"): o FTS5 não tem radical em português.
 */
export function ftsQuery(text: string): string {
  const terms = [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
  return terms.map((w) => (w.length >= 4 ? `"${w}"*` : `"${w}"`)).join(' OR ');
}

/** Índice da base de conhecimento no banco do perfil (spec knowledge-base §5.2). */
export class KnowledgeStore {
  private vectorCache: { model: string; rows: Array<{ id: number; base: string; vector: Float32Array }> } | undefined;

  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kb_documents (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        base TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        chunks INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id INTEGER PRIMARY KEY,
        doc_id INTEGER NOT NULL,
        base TEXT NOT NULL,
        ord INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB,
        embed_model TEXT
      );
      CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2');
    `);
  }

  documents(): KnowledgeDocument[] {
    return this.db
      .prepare<[], { id: number; key: string; base: string; mtime_ms: number; size: number; chunks: number }>('SELECT id, key, base, mtime_ms, size, chunks FROM kb_documents ORDER BY key')
      .all()
      .map((r) => ({ id: r.id, key: r.key, base: r.base, mtimeMs: r.mtime_ms, size: r.size, chunks: r.chunks }));
  }

  /** Substitui os trechos de um documento (reindexação completa dele). */
  replaceDocument(doc: { key: string; base: string; mtimeMs: number; size: number }, chunks: string[]): void {
    this.db.transaction(() => {
      this.removeDocument(doc.key);
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO kb_documents (key, base, mtime_ms, size, chunks) VALUES (?, ?, ?, ?, ?)')
        .run(doc.key, doc.base, doc.mtimeMs, doc.size, chunks.length);
      const insert = this.db.prepare('INSERT INTO kb_chunks (doc_id, base, ord, text) VALUES (?, ?, ?, ?)');
      const fts = this.db.prepare('INSERT INTO kb_fts (rowid, text) VALUES (?, ?)');
      chunks.forEach((text, ord) => {
        const { lastInsertRowid: chunkId } = insert.run(lastInsertRowid, doc.base, ord, text);
        fts.run(chunkId, text);
      });
    })();
    this.vectorCache = undefined;
  }

  removeDocument(key: string): void {
    const doc = this.db.prepare<[string], { id: number }>('SELECT id FROM kb_documents WHERE key = ?').get(key);
    if (!doc) return;
    this.db.prepare('DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(doc.id);
    this.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(doc.id);
    this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(doc.id);
    this.vectorCache = undefined;
  }

  /** Trechos ainda sem vetor deste modelo (novos, ou indexados com outro provedor). */
  pendingEmbeddings(model: string, limit: number): Array<{ id: number; text: string }> {
    return this.db
      .prepare<[string, number], { id: number; text: string }>('SELECT id, text FROM kb_chunks WHERE embed_model IS NULL OR embed_model <> ? ORDER BY id LIMIT ?')
      .all(model, limit);
  }

  saveEmbeddings(model: string, items: Array<{ id: number; vector: Float32Array }>): void {
    const update = this.db.prepare('UPDATE kb_chunks SET embedding = ?, embed_model = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const { id, vector } of items) update.run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), model, id);
    })();
    this.vectorCache = undefined;
  }

  stats(): { chunks: number; embedded: Record<string, number> } {
    const chunks = this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM kb_chunks').get()!.n;
    const embedded = Object.fromEntries(
      this.db
        .prepare<[], { model: string; n: number }>('SELECT embed_model AS model, COUNT(*) AS n FROM kb_chunks WHERE embed_model IS NOT NULL GROUP BY embed_model')
        .all()
        .map((r) => [r.model, r.n]),
    );
    return { chunks, embedded };
  }

  chunk(id: number): KnowledgeChunk | undefined {
    const row = this.db
      .prepare<[number], { id: number; key: string; base: string; ord: number; text: string }>(
        'SELECT c.id, d.key, c.base, c.ord, c.text FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id WHERE c.id = ?',
      )
      .get(id);
    return row ? { id: row.id, docKey: row.key, base: row.base, ord: row.ord, text: row.text } : undefined;
  }

  /** Busca lexical (BM25 do FTS5), opcionalmente restrita a bases. Devolve ids em ordem de relevância. */
  lexical(query: string, bases: string[] | undefined, limit: number): number[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const filter = bases?.length ? ` AND c.base IN (${bases.map(() => '?').join(',')})` : '';
    return this.db
      .prepare<unknown[], { id: number }>(`SELECT c.id FROM kb_fts f JOIN kb_chunks c ON c.id = f.rowid WHERE kb_fts MATCH ?${filter} ORDER BY bm25(kb_fts) LIMIT ?`)
      .all(match, ...(bases ?? []), limit)
      .map((r) => r.id);
  }

  /** Busca vetorial por cosseno (força bruta: bases pessoais cabem folgadas na memória). */
  vector(query: Float32Array, model: string, bases: string[] | undefined, limit: number): number[] {
    if (this.vectorCache?.model !== model) {
      const rows = this.db
        .prepare<[string], { id: number; base: string; embedding: Buffer }>('SELECT id, base, embedding FROM kb_chunks WHERE embed_model = ? AND embedding IS NOT NULL')
        .all(model)
        .map((r) => ({ id: r.id, base: r.base, vector: new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)) }));
      this.vectorCache = { model, rows };
    }
    const qn = norm(query);
    if (!qn) return [];
    return this.vectorCache.rows
      .filter((r) => !bases?.length || bases.includes(r.base))
      .map((r) => ({ id: r.id, score: dot(query, r.vector) / (qn * (norm(r.vector) || 1)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.id);
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return sum;
}

function norm(v: Float32Array): number {
  return Math.sqrt(dot(v, v));
}

/** Reciprocal Rank Fusion: soma 1/(k + posição) de cada lista; k=60 como no artigo original. */
export function reciprocalRankFusion(rankings: number[][], k = 60): Array<{ id: number; score: number }> {
  const scores = new Map<number, number>();
  for (const ranking of rankings) ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
