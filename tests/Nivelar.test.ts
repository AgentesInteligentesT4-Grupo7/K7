import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Core } from '../src/app/createCore.js';
import { WebChannel } from '../src/canais/web/WebChannel.js';
import { Config } from '../src/config/Config.js';
import { DocumentExtractor } from '../src/documents/DocumentExtractor.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { AudioLeveler } from '../src/modules/midia/AudioLeveler.js';
import { MediaLibrary } from '../src/modules/midia/MediaLibrary.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';

/** Serviço de mentira: "nivela" devolvendo "NIVELADO:" + conteúdo, com os volumes nos cabeçalhos. */
function fakeService(): http.Server {
  return http.createServer((req, res) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('nome') ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!/\.(mp3|mp4)$/.test(name)) return void res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'formato não suportado' }));
      res.writeHead(200, { 'x-volume-antes': '-23.9', 'x-volume-depois': '-14.0' }).end(Buffer.concat([Buffer.from('NIVELADO:'), ...chunks]));
    });
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Nivelamento de volume', () => {
  const service = fakeService();
  let serviceUrl = '';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nivelar-'));
  const library = new MediaLibrary(dir);
  const ANA = 'visitante-ana-0000000000000001';
  const owner = `web-${createHash('sha256').update(ANA).digest('hex').slice(0, 16)}`;
  let channel: WebChannel;
  let base = '';

  before(async () => {
    serviceUrl = await listen(service);
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
      leveler: new AudioLeveler({ baseUrl: serviceUrl, timeoutMs: 5_000 }),
      createController: () => ({ listSkills: () => [] }),
    } as unknown as Core;
    channel = new WebChannel(core, { host: '127.0.0.1', port: 0, userId: 'web', public: true });
    await channel.start();
    base = new URL(channel.url).origin;
  });
  after(() => {
    service.close();
    return channel.stop();
  });

  it('arquivo no servidor é trocado pela versão nivelada (sem ficar pela metade); formato não suportado avisa', async () => {
    const leveler = new AudioLeveler({ baseUrl: serviceUrl, timeoutMs: 5_000 });
    const file = path.join(dir, 'musica.mp3');
    fs.writeFileSync(file, 'ID3');
    assert.deepEqual(await leveler.levelFile(file), { before: -23.9, after: -14 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'NIVELADO:ID3');
    assert.ok(!fs.existsSync(`${file}.nivelando`));
    await assert.rejects(leveler.levelStream(Buffer.from('x'), 'nota.txt'), /não dá para nivelar/);
  });

  it('arquivo da pasta do visitante: vai, volta nivelado e nada fica guardado', async () => {
    const res = await fetch(`${base}/api/nivelar?nome=${encodeURIComponent('Minha música.mp3')}`, {
      method: 'POST',
      headers: { 'x-visitante': ANA, 'content-type': 'application/octet-stream' },
      body: Buffer.from('ID3-local'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-volume-antes'), '-23.9');
    assert.equal(await res.text(), 'NIVELADO:ID3-local');
    const bad = await fetch(`${base}/api/nivelar?nome=nota.txt`, { method: 'POST', headers: { 'x-visitante': ANA }, body: 'x' });
    assert.equal(bad.status, 422);
    assert.equal((await fetch(`${base}/api/nivelar?nome=a.mp3`, { method: 'POST', body: 'x' })).status, 400, 'sem visitante');
  });

  it('playlist baixada: nivela todas as faixas no servidor e fica marcada; faixa nova tira a marca', async () => {
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
    const files = ['A.mp3', 'B.mp3'].map((name) => {
      const file = path.join(dir, 'downloads', name);
      fs.writeFileSync(file, name);
      return file;
    });
    const entry = library.add(owner, { titulo: 'Lista', url: 'https://youtu.be/x', formato: 'mp3', arquivos: files })!;
    const res = await fetch(`${base}/api/biblioteca/${entry.id}/nivelar`, { method: 'POST', headers: { 'x-visitante': ANA } });
    assert.deepEqual(await res.json(), { ok: true, niveladas: 2, problemas: [] });
    assert.equal(fs.readFileSync(files[0]!, 'utf8'), 'NIVELADO:A.mp3');
    const list = (await (await fetch(`${base}/api/biblioteca`, { headers: { 'x-visitante': ANA } })).json()) as Array<{ nivelada: boolean }>;
    assert.equal(list[0]!.nivelada, true);

    const extra = path.join(dir, 'downloads', 'C.mp3');
    fs.writeFileSync(extra, 'C');
    library.add(owner, { titulo: 'Lista', url: 'https://youtu.be/x', formato: 'mp3', arquivos: [...files, extra] }, entry.id);
    assert.equal(library.get(owner, entry.id)!.nivelada, false);
  });
});
