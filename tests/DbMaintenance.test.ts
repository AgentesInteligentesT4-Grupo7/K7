import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { DatabaseMaintenance } from '../src/memory/DatabaseMaintenance.js';

describe('DatabaseMaintenance', () => {
  it('cria um backup por dia e mantém só os N mais recentes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-'));
    const db = DatabaseConnection.open(path.join(dir, 'main.db'));
    const backupDir = path.join(dir, 'backups');
    const maintenance = new DatabaseMaintenance(db, { backupDir, keepBackups: 2, vacuumFreeRatio: 0.2, intervalMs: 1000 });
    try {
      for (const day of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-16']) {
        await maintenance.backup(new Date(`${day}T12:00:00Z`));
      }
      assert.deepEqual(fs.readdirSync(backupDir).sort(), ['agrominds-2026-10-15.db', 'agrominds-2026-10-16.db']);
      const restored = DatabaseConnection.open(path.join(backupDir, 'agrominds-2026-10-16.db'));
      assert.ok(restored.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get());
      restored.close();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VACUUM só roda com muitas páginas livres', () => {
    const db = DatabaseConnection.open(':memory:');
    const maintenance = new DatabaseMaintenance(db, { backupDir: os.tmpdir(), keepBackups: 1, vacuumFreeRatio: 0.2, intervalMs: 1000 });
    assert.equal(maintenance.vacuumIfNeeded(), false);
    const insert = db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES ('c', 'user', ?)");
    for (let i = 0; i < 300; i++) insert.run('x'.repeat(2000));
    db.exec('DELETE FROM messages');
    assert.equal(maintenance.vacuumIfNeeded(), true);
  });
});
