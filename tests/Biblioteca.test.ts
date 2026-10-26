import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ProgressBoard } from '../src/agent/ProgressBoard.js';
import type { Core } from '../src/app/createCore.js';
import { WebChannel } from '../src/canais/web/WebChannel.js';
import { Config } from '../src/config/Config.js';
import { DocumentExtractor } from '../src/documents/DocumentExtractor.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { MediaLibrary } from '../src/modules/midia/MediaLibrary.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';

function workspaceWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblioteca-'));
  fs.mkdirSync(path.join(dir, 'downloads'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'downloads', name), content);
  return dir;
}

describe('Biblioteca dos downloads', () => {
  it('uma entrada por pedido, na ordem; repetir o mesmo link atualiza; cada dono vê só as suas', () => {
    const dir = workspaceWith({ 'Faixa A.mp3': 'a', 'Faixa B.mp3': 'b' });
    const library = new MediaLibrary(dir);
    const files = ['Faixa B.mp3', 'Faixa A.mp3'].map((f) => path.join(dir, 'downloads', f));
    const first = library.add('ana', { titulo: 'Minha playlist', url: 'https://youtu.be/p', formato: 'mp3', arquivos: files })!;
    library.add('ana', { titulo: 'Minha playlist', url: 'https://youtu.be/p', formato: 'mp3', arquivos: files });
    library.add('beto', { titulo: 'Do Beto', url: 'https://youtu.be/b', formato: 'mp3', arquivos: [files[0]!] });

    const ana = library.list('ana');
    assert.equal(ana.length, 1, 'o mesmo link no mesmo formato não repete');
    assert.equal(ana[0]!.id, first.id);
    assert.deepEqual(ana[0]!.faixas.map((t) => t.nome), ['Faixa B', 'Faixa A'], 'na ordem da playlist');
    assert.deepEqual(library.list('beto').map((e) => e.titulo), ['Do Beto']);
    assert.match(first.id, /^[0-9a-f]{24}$/);

    // Sobrevive a reiniciar; arquivo apagado some da lista; tirar da biblioteca não apaga o arquivo.
    fs.unlinkSync(files[1]!);
    const reloaded = new MediaLibrary(dir);
    assert.deepEqual(reloaded.list('ana')[0]!.faixas.map((t) => t.nome), ['Faixa B']);
    assert.equal(reloaded.track(first.id, 0)!.nome, 'Faixa B.mp3');
    assert.equal(reloaded.track(first.id, 1), undefined);
    assert.equal(reloaded.remove('beto', first.id), false, 'só o dono tira');
    assert.equal(reloaded.remove('ana', first.id), true);
    assert.deepEqual(reloaded.list('ana'), []);
    assert.ok(fs.existsSync(files[0]!));
  });
});

describe('Biblioteca no chat (público) e andamento', () => {
  const dir = workspaceWith({ 'Musica.mp3': 'ID3-0123456789' });
  const library = new MediaLibrary(dir);
  const ANA = 'visitante-ana-0000000000000001';
  const BETO = 'visitante-beto-000000000000002';
  const owner = (visitor: string) => `web-${createHash('sha256').update(visitor).digest('hex').slice(0, 16)}`;
  let channel: WebChannel;
  let base = '';

  before(async () => {
    const config = new Config({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k', DB_PATH: path.join(dir, 'a.db'), MODULES: 'midia' }, dir);
    const tmp = new TempFileManager(path.join(dir, 'tmp'));
    tmp.initialize();
    const core = {
      config,
      tmp,
      memory: new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 }),
      llm: { name: 'falso', model: 'eco', providerNames: ['falso'] },
      tts: { name: 'tts', voice: 'v', synthesize: async () => ({ audio: Buffer.from(''), format: 'ogg' }) },
      stt: { transcribe: async () => '' },
      documents: new DocumentExtractor(),
      library,
      createController: () => ({ listSkills: () => [] }),
    } as unknown as Core;
    channel = new WebChannel(core, { host: '127.0.0.1', port: 0, userId: 'web', public: true });
    await channel.start();
    base = new URL(channel.url).origin;
  });
  after(() => channel.stop());

  const get = (route: string, visitor?: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${route}`, { headers: { ...(visitor ? { 'x-visitante': visitor } : {}), ...headers } });

  it('cada visitante vê só as suas playlists; a faixa toca por partes (Range); só o dono tira', async () => {
    library.add(owner(ANA), { titulo: 'Da Ana', url: 'https://youtu.be/a', formato: 'mp3', arquivos: [path.join(dir, 'downloads', 'Musica.mp3')] });
    const info = (await (await get('/api/info', ANA)).json()) as { biblioteca: boolean };
    assert.equal(info.biblioteca, true);

    const ana = (await (await get('/api/biblioteca', ANA)).json()) as Array<{ id: string; titulo: string; faixas: Array<{ nome: string; url: string }> }>;
    assert.deepEqual(ana.map((e) => [e.titulo, e.faixas.map((t) => t.nome)]), [['Da Ana', ['Musica']]]);
    assert.deepEqual(await (await get('/api/biblioteca', BETO)).json(), []);

    const url = ana[0]!.faixas[0]!.url;
    const full = await get(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), 'ID3-0123456789');
    const part = await get(url, undefined, { range: 'bytes=4-7' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 4-7/14');
    assert.equal(await part.text(), '0123');
    assert.equal((await get(url, undefined, { range: 'bytes=99-' })).status, 416);
    assert.equal((await get(`/api/biblioteca/${'0'.repeat(24)}/0`)).status, 404);

    const remove = (visitor: string) => fetch(`${base}/api/biblioteca/${ana[0]!.id}`, { method: 'DELETE', headers: { 'x-visitante': visitor } });
    assert.equal((await remove(BETO)).status, 404);
    assert.equal((await remove(ANA)).status, 200);
    assert.deepEqual(await (await get('/api/biblioteca', ANA)).json(), []);
  });

  it('andamento com números para a barra de %', async () => {
    ProgressBoard.set(owner(ANA), '⬇️ Baixando 30 de 120…', { done: 30, total: 120 });
    assert.deepEqual(await (await get('/api/progresso', ANA)).json(), { texto: '⬇️ Baixando 30 de 120…', feitos: 30, total: 120 });
    assert.deepEqual(await (await get('/api/progresso', BETO)).json(), { texto: null, feitos: null, total: null });
    ProgressBoard.clear(owner(ANA));
  });
});
