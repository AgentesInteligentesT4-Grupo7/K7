import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../../../memory/DatabaseConnection.js';

export type AccessStatus = 'pendente' | 'ativo' | 'bloqueado';
export type AccessOrigin = 'convite' | 'pedido' | 'manual' | 'aberto';

export interface AccessEntry {
  userId: number;
  nome: string;
  username: string | null;
  status: AccessStatus;
  origem: AccessOrigin;
  convite: string | null;
  criadoEm: string;
  atualizadoEm: string;
  ultimoContato: string | null;
}

export interface Invite {
  codigo: string;
  nome: string | null;
  criadoEm: string;
  expiraEm: string;
  usosMax: number;
  usos: number;
  revogado: boolean;
}

export type RedeemResult = { ok: true; entry: AccessEntry } | { ok: false; motivo: 'invalido' | 'expirado' | 'esgotado' | 'revogado' };

/** Quem chega pelo Telegram: identificação vinda do próprio Telegram. */
export interface TelegramPerson {
  id: number;
  nome: string;
  username?: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS telegram_acessos (
    user_id        INTEGER PRIMARY KEY,
    nome           TEXT NOT NULL,
    username       TEXT,
    status         TEXT NOT NULL CHECK (status IN ('pendente', 'ativo', 'bloqueado')),
    origem         TEXT NOT NULL,
    convite        TEXT,
    criado_em      TEXT NOT NULL DEFAULT (datetime('now')),
    atualizado_em  TEXT NOT NULL DEFAULT (datetime('now')),
    ultimo_contato TEXT
  );
  CREATE TABLE IF NOT EXISTS telegram_convites (
    codigo     TEXT PRIMARY KEY,
    nome       TEXT,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now')),
    expira_em  TEXT NOT NULL,
    usos_max   INTEGER NOT NULL DEFAULT 1,
    usos       INTEGER NOT NULL DEFAULT 0,
    revogado   INTEGER NOT NULL DEFAULT 0
  );
`;

/** Formato aceito no `?start=` do Telegram: até 64 caracteres A-Z, a-z, 0-9, _ e -. */
export const INVITE_CODE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Quem pode usar o bot desta fita, além dos donos do `.env`: pessoas liberadas por convite, pedido aprovado ou
 * cadastro manual, e os convites (link `t.me/<bot>?start=<código>`). Fica no banco da fita: cada fita tem o seu bot
 * e a sua lista, e liberar alguém numa fita não libera nas outras.
 */
export class TelegramAccessStore {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(SCHEMA);
  }

  get(userId: number): AccessEntry | undefined {
    const row = this.db.prepare('SELECT * FROM telegram_acessos WHERE user_id = ?').get(userId) as Row | undefined;
    return row && toEntry(row);
  }

  list(status?: AccessStatus): AccessEntry[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM telegram_acessos WHERE status = ? ORDER BY atualizado_em DESC').all(status)
      : this.db.prepare('SELECT * FROM telegram_acessos ORDER BY status, atualizado_em DESC').all()) as Row[];
    return rows.map(toEntry);
  }

  /** Cadastra ou atualiza (nome e @ vêm do Telegram e podem mudar). */
  save(person: TelegramPerson, status: AccessStatus, origem: AccessOrigin, convite?: string): AccessEntry {
    this.db
      .prepare(
        `INSERT INTO telegram_acessos (user_id, nome, username, status, origem, convite) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET nome = excluded.nome, username = excluded.username, status = excluded.status,
           origem = excluded.origem, convite = COALESCE(excluded.convite, telegram_acessos.convite), atualizado_em = datetime('now')`,
      )
      .run(person.id, person.nome, person.username ?? null, status, origem, convite ?? null);
    return this.get(person.id)!;
  }

  setStatus(userId: number, status: AccessStatus): AccessEntry | undefined {
    this.db.prepare("UPDATE telegram_acessos SET status = ?, atualizado_em = datetime('now') WHERE user_id = ?").run(status, userId);
    return this.get(userId);
  }

  remove(userId: number): boolean {
    return this.db.prepare('DELETE FROM telegram_acessos WHERE user_id = ?').run(userId).changes > 0;
  }

  touch(userId: number): void {
    this.db.prepare("UPDATE telegram_acessos SET ultimo_contato = datetime('now') WHERE user_id = ?").run(userId);
  }

  createInvite(options: { nome?: string; dias?: number; usos?: number } = {}): Invite {
    const codigo = randomBytes(12).toString('base64url');
    const dias = Math.max(1, Math.min(90, Math.floor(options.dias ?? 7)));
    const usos = Math.max(1, Math.min(1000, Math.floor(options.usos ?? 1)));
    this.db
      .prepare(`INSERT INTO telegram_convites (codigo, nome, expira_em, usos_max) VALUES (?, ?, datetime('now', ?), ?)`)
      .run(codigo, options.nome?.trim() || null, `+${dias} days`, usos);
    return this.invite(codigo)!;
  }

  invite(codigo: string): Invite | undefined {
    const row = this.db.prepare('SELECT * FROM telegram_convites WHERE codigo = ?').get(codigo) as InviteRow | undefined;
    return row && toInvite(row);
  }

  listInvites(): Invite[] {
    return (this.db.prepare('SELECT * FROM telegram_convites ORDER BY criado_em DESC').all() as InviteRow[]).map(toInvite);
  }

  revokeInvite(codigo: string): boolean {
    return this.db.prepare('UPDATE telegram_convites SET revogado = 1 WHERE codigo = ?').run(codigo).changes > 0;
  }

  /** Usa um convite: libera a pessoa e conta o uso, numa transação (dois cliques ao mesmo tempo não passam do limite). */
  redeem(codigo: string, person: TelegramPerson): RedeemResult {
    if (!INVITE_CODE.test(codigo)) return { ok: false, motivo: 'invalido' };
    return this.db.transaction((): RedeemResult => {
      const row = this.db.prepare("SELECT *, expira_em < datetime('now') AS vencido FROM telegram_convites WHERE codigo = ?").get(codigo) as
        | (InviteRow & { vencido: number })
        | undefined;
      if (!row) return { ok: false, motivo: 'invalido' };
      if (row.revogado) return { ok: false, motivo: 'revogado' };
      if (row.vencido) return { ok: false, motivo: 'expirado' };
      if (row.usos >= row.usos_max) return { ok: false, motivo: 'esgotado' };
      this.db.prepare('UPDATE telegram_convites SET usos = usos + 1 WHERE codigo = ?').run(codigo);
      return { ok: true, entry: this.save(person, 'ativo', 'convite', codigo) };
    })();
  }
}

interface Row {
  user_id: number;
  nome: string;
  username: string | null;
  status: AccessStatus;
  origem: AccessOrigin;
  convite: string | null;
  criado_em: string;
  atualizado_em: string;
  ultimo_contato: string | null;
}

interface InviteRow {
  codigo: string;
  nome: string | null;
  criado_em: string;
  expira_em: string;
  usos_max: number;
  usos: number;
  revogado: number;
}

const toEntry = (r: Row): AccessEntry => ({
  userId: r.user_id,
  nome: r.nome,
  username: r.username,
  status: r.status,
  origem: r.origem,
  convite: r.convite,
  criadoEm: r.criado_em,
  atualizadoEm: r.atualizado_em,
  ultimoContato: r.ultimo_contato,
});

const toInvite = (r: InviteRow): Invite => ({
  codigo: r.codigo,
  nome: r.nome,
  criadoEm: r.criado_em,
  expiraEm: r.expira_em,
  usosMax: r.usos_max,
  usos: r.usos,
  revogado: r.revogado === 1,
});
