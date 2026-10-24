import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import type { SqliteDatabase } from './DatabaseConnection.js';

export interface MaintenanceOptions {
  backupDir: string;
  /** Quantos backups diários manter. */
  keepBackups: number;
  /** Fração de páginas livres que dispara o VACUUM (ex.: 0.2 = 20%). */
  vacuumFreeRatio: number;
  intervalMs: number;
}

/**
 * Mitigações da arquitetura (risco "Corrupção do SQLite") e da spec de memória
 * ("Vacuum ocasional"): backup diário rotativo via API de backup online do SQLite
 * e VACUUM quando há muitas páginas livres.
 */
export class DatabaseMaintenance {
  private readonly logger = new Logger('DbMaintenance');
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: MaintenanceOptions,
  ) {}

  /** Roda uma vez agora e depois a cada `intervalMs`. */
  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<void> {
    try {
      await this.backup(now);
      this.vacuumIfNeeded();
      this.db.pragma('optimize');
    } catch (error) {
      this.logger.warn(`Manutenção do banco falhou: ${errorMessage(error)}`);
    }
  }

  /** Um arquivo por dia (`k7-AAAA-MM-DD.db`); mantém os `keepBackups` mais recentes (os de antes da troca de nome, `parreiraclaw-*`, entram na conta). */
  async backup(now = new Date()): Promise<string | null> {
    fs.mkdirSync(this.options.backupDir, { recursive: true });
    const target = path.join(this.options.backupDir, `k7-${now.toISOString().slice(0, 10)}.db`);
    if (fs.existsSync(target)) return null;

    await this.db.backup(target);
    this.logger.info(`💾 Backup do SQLite criado: ${path.basename(target)}`);

    const backups = fs
      .readdirSync(this.options.backupDir)
      .filter((file) => /^(?:k7|parreiraclaw)-\d{4}-\d{2}-\d{2}\.db$/.test(file))
      // Pela data do nome, não pelo nome inteiro: "k7-" e "parreiraclaw-" se misturam na ordem alfabética.
      .sort((a, b) => b.slice(-13).localeCompare(a.slice(-13)));
    for (const old of backups.slice(this.options.keepBackups)) {
      fs.rmSync(path.join(this.options.backupDir, old), { force: true });
    }
    return target;
  }

  vacuumIfNeeded(): boolean {
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    const free = Number(this.db.pragma('freelist_count', { simple: true }));
    if (pages === 0 || free / pages < this.options.vacuumFreeRatio) return false;
    this.db.exec('VACUUM');
    this.logger.info(`🧹 VACUUM executado (${free}/${pages} páginas livres)`);
    return true;
  }
}
