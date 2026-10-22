import type { SqliteDatabase } from '../../memory/DatabaseConnection.js';
import type { Task } from './types.js';

export interface ModelStats {
  evalScore: number | null;
  evalSamples: number;
  successes: number;
  failures: number;
  latencyMs: number | null;
  feedback: number;
}

const EMPTY: ModelStats = { evalScore: null, evalSamples: 0, successes: 0, failures: 0, latencyMs: null, feedback: 0 };

/**
 * Desempenho medido de cada modelo por tarefa (RF-06, RF-07, RF-10), persistido no SQLite.
 * Cooldowns de cota ficam em memória: reiniciar o bot dá uma nova chance a todos.
 */
export class ScoreStore {
  private readonly cooldowns = new Map<string, { until: number; reason: string }>();

  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_scores (
        task          TEXT NOT NULL,
        model_key     TEXT NOT NULL,
        eval_score    REAL,
        eval_samples  INTEGER NOT NULL DEFAULT 0,
        successes     INTEGER NOT NULL DEFAULT 0,
        failures      INTEGER NOT NULL DEFAULT 0,
        latency_ms    REAL,
        feedback      INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task, model_key)
      );
    `);
  }

  get(task: Task, key: string): ModelStats {
    const row = this.db
      .prepare<[string, string], { eval_score: number | null; eval_samples: number; successes: number; failures: number; latency_ms: number | null; feedback: number }>(
        'SELECT eval_score, eval_samples, successes, failures, latency_ms, feedback FROM model_scores WHERE task = ? AND model_key = ?',
      )
      .get(task, key);
    return row
      ? { evalScore: row.eval_score, evalSamples: row.eval_samples, successes: row.successes, failures: row.failures, latencyMs: row.latency_ms, feedback: row.feedback }
      : { ...EMPTY };
  }

  private ensure(task: Task, key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO model_scores (task, model_key) VALUES (?, ?)').run(task, key);
  }

  recordSuccess(task: Task, key: string, latencyMs: number): void {
    this.ensure(task, key);
    // Média móvel exponencial: latências recentes pesam mais.
    this.db
      .prepare(
        "UPDATE model_scores SET successes = successes + 1, latency_ms = CASE WHEN latency_ms IS NULL THEN ? ELSE latency_ms * 0.7 + ? * 0.3 END, updated_at = datetime('now') WHERE task = ? AND model_key = ?",
      )
      .run(latencyMs, latencyMs, task, key);
  }

  recordFailure(task: Task, key: string): void {
    this.ensure(task, key);
    this.db.prepare("UPDATE model_scores SET failures = failures + 1, updated_at = datetime('now') WHERE task = ? AND model_key = ?").run(task, key);
  }

  recordEval(task: Task, key: string, score: number, samples: number): void {
    this.ensure(task, key);
    this.db
      .prepare("UPDATE model_scores SET eval_score = ?, eval_samples = ?, updated_at = datetime('now') WHERE task = ? AND model_key = ?")
      .run(score, samples, task, key);
  }

  /** 👍 = +1, 👎 = −1, acumulado com limite de ±5. */
  recordFeedback(task: Task, key: string, delta: 1 | -1): number {
    this.ensure(task, key);
    this.db
      .prepare("UPDATE model_scores SET feedback = MAX(-5, MIN(5, feedback + ?)), updated_at = datetime('now') WHERE task = ? AND model_key = ?")
      .run(delta, task, key);
    return this.get(task, key).feedback;
  }

  setCooldown(key: string, ms: number, reason: string): void {
    this.cooldowns.set(key, { until: Date.now() + ms, reason });
  }

  cooldown(key: string): { until: number; reason: string } | undefined {
    const entry = this.cooldowns.get(key);
    if (entry && entry.until <= Date.now()) {
      this.cooldowns.delete(key);
      return undefined;
    }
    return entry;
  }
}
