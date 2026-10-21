import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';

const newMemory = (windowSize = 4, maxMessageChars = 1000) =>
  new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize, maxMessageChars });

describe('MemoryManager', () => {
  it('RF-01/RF-02: cria o arquivo, as tabelas e ativa WAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-'));
    const dbPath = path.join(dir, 'sub', 'test.db');
    const db = DatabaseConnection.open(dbPath);
    try {
      assert.ok(fs.existsSync(dbPath));
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      assert.ok(tables.some((t) => t.name === 'conversations'));
      assert.ok(tables.some((t) => t.name === 'messages'));
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reutiliza a conversa ativa do usuário', () => {
    const memory = newMemory();
    const a = memory.getOrCreateActiveConversation('42', 'gemini');
    const b = memory.getOrCreateActiveConversation('42', 'gemini');
    assert.equal(a.id, b.id);
    assert.notEqual(memory.getOrCreateActiveConversation('43', 'gemini').id, a.id);
  });

  it('RF-03: devolve só a janela recente sem apagar o histórico', () => {
    const memory = newMemory(4);
    const { id } = memory.getOrCreateActiveConversation('1', 'gemini');
    for (let i = 1; i <= 5; i++) {
      memory.saveMessage(id, 'user', `pergunta ${i}`);
      memory.saveMessage(id, 'tool', `tool ${i}`);
      memory.saveMessage(id, 'assistant', `resposta ${i}`);
    }
    const window = memory.getContextWindow(id);
    assert.deepEqual(
      window.map((m) => m.content),
      ['pergunta 4', 'resposta 4', 'pergunta 5', 'resposta 5'],
    );
    assert.equal(memory.countMessages(id), 15);
  });

  it('a janela sempre começa por uma mensagem do usuário', () => {
    const memory = newMemory(3);
    const { id } = memory.getOrCreateActiveConversation('1', 'gemini');
    memory.saveMessage(id, 'user', 'u1');
    memory.saveMessage(id, 'assistant', 'a1');
    memory.saveMessage(id, 'user', 'u2');
    memory.saveMessage(id, 'assistant', 'a2');
    assert.equal(memory.getContextWindow(id)[0]!.role, 'user');
  });

  it('EC-02/EC-03: remove null bytes e trunca mensagens gigantes', () => {
    const memory = newMemory(10, 100);
    const { id } = memory.getOrCreateActiveConversation('1', 'gemini');
    memory.saveMessage(id, 'user', 'ol\u0000á');
    memory.saveMessage(id, 'assistant', 'x'.repeat(500));
    const [user, assistant] = memory.getContextWindow(id);
    assert.equal(user!.content, 'olá');
    assert.ok(assistant!.content!.length <= 100);
    assert.match(assistant!.content!, /truncado/);
  });

  it('/nova arquiva a conversa atual e abre outra', () => {
    const memory = newMemory();
    const first = memory.getOrCreateActiveConversation('1', 'gemini');
    const second = memory.startNewConversation('1', 'gemini');
    assert.notEqual(first.id, second.id);
    assert.equal(memory.getOrCreateActiveConversation('1', 'gemini').id, second.id);
  });
});
