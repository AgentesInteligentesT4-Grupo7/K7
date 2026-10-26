import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Core } from '../src/app/createCore.js';
import { WebChannel } from '../src/canais/web/WebChannel.js';
import { Config } from '../src/config/Config.js';
import { DocumentExtractor } from '../src/documents/DocumentExtractor.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { MediaDownloader } from '../src/modules/midia/MediaDownloader.js';
import { MediaLibrary } from '../src/modules/midia/MediaLibrary.js';
import type { DownloadRequest, DownloadResult, YtdlpClient } from '../src/modules/midia/YtdlpClient.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';

const PLAYLIST = ['https://youtu.be/AAAAAAAAAAA', 'https://youtu.be/BBBBBBBBBBB', 'https://youtu.be/CCCCCCCCCCC'];

/**
 * Serviço de mentira: cada link vira "<id>.mp3", menos os de `failing`, que voltam como falha.
 * Avisa a cada arquivo pronto (como o cliente real ao copiar durante o download).
 */
function fakeClient(failing: Set<string>, calls: DownloadRequest[]): YtdlpClient {
  return {
    download: async (request: DownloadRequest, targetDir: string, _progress?: unknown, onUpdate?: (r: DownloadResult) => void) => {
      calls.push(request);
      const links = request.links?.length ? request.links : PLAYLIST;
      const ids = links.map((l) => l.slice(-11));
      const result: DownloadResult = { files: [], failures: [], skipped: [], ...(request.links ? {} : { title: 'Playlist de teste' }), order: ids };
      for (const [i, id] of ids.entries()) {
        if (failing.has(id)) {
          result.failures.push({ link: links[i]!, motivo: 'vídeo privado' });
          continue;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        const file = path.join(targetDir, `${id}.mp3`);
        fs.writeFileSync(file, id);
        result.files.push({ path: file, id });
        onUpdate?.({ ...result, files: [...result.files] });
      }
      return result;
    },
  } as unknown as YtdlpClient;
}

describe('Downloads: biblioteca crescendo, vários links e tentar de novo', () => {
  it('a playlist entra na biblioteca a cada arquivo; falhas guardadas; tentar de novo baixa só elas e soma', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-'));
    const library = new MediaLibrary(dir);
    const calls: DownloadRequest[] = [];
    const failing = new Set(['BBBBBBBBBBB']);
    const seen: number[] = [];
    const add = library.add.bind(library);
    library.add = (dono, item, entryId) => (seen.push(item.arquivos.length), add(dono, item, entryId));
    const downloader = new MediaDownloader(fakeClient(failing, calls), dir, library);

    const first = await downloader.download({ url: 'https://www.youtube.com/playlist?list=PL1', formato: 'mp3', playlist: true, userId: 'ana' });
    assert.deepEqual(seen.slice(0, 2), [1, 2], 'cada arquivo pronto já aparece');
    assert.deepEqual(first.failures, [{ link: PLAYLIST[1], motivo: 'vídeo privado' }]);
    const [entry] = library.list('ana');
    assert.equal(entry!.titulo, 'Playlist de teste');
    assert.deepEqual(entry!.faixas.map((t) => t.nome), ['AAAAAAAAAAA', 'CCCCCCCCCCC']);
    assert.deepEqual(entry!.falhas, [{ link: PLAYLIST[1], motivo: 'vídeo privado' }]);

    failing.clear();
    const retried = await downloader.retry('ana', entry!.id);
    assert.deepEqual(calls[1]!.links, [PLAYLIST[1]], 'só os que falharam');
    assert.equal(retried.failures.length, 0);
    const [again] = library.list('ana');
    assert.equal(again!.id, entry!.id, 'a mesma playlist');
    assert.deepEqual(again!.faixas.map((t) => t.nome), ['AAAAAAAAAAA', 'CCCCCCCCCCC', 'BBBBBBBBBBB']);
    assert.deepEqual(again!.falhas, []);
    await assert.rejects(downloader.retry('ana', entry!.id), /Não há links com falha/);
    await assert.rejects(downloader.retry('beto', entry!.id), /Playlist não encontrada/);

    // Vários links num pedido: uma lista só.
    const many = await downloader.download({ links: ['https://youtu.be/DDDDDDDDDDD', 'https://youtu.be/EEEEEEEEEEE'], formato: 'mp3', playlist: false, userId: 'ana' });
    assert.equal(many.files.length, 2);
    assert.match(library.list('ana')[0]!.titulo, /^2 link\(s\) de /);
  });
});

describe('Biblioteca no chat: .zip da playlist e tentar de novo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblioteca-web-'));
  const library = new MediaLibrary(dir);
  const failing = new Set(['BBBBBBBBBBB']);
  const downloader = new MediaDownloader(fakeClient(failing, []), dir, library);
  const ANA = 'visitante-ana-0000000000000001';
  const owner = `web-${createHash('sha256').update(ANA).digest('hex').slice(0, 16)}`;
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
      mediaDownloader: downloader,
      createController: () => ({ listSkills: () => [] }),
    } as unknown as Core;
    channel = new WebChannel(core, { host: '127.0.0.1', port: 0, userId: 'web', public: true });
    await channel.start();
    base = new URL(channel.url).origin;
  });
  after(() => channel.stop());

  const listFor = async (visitor: string) =>
    (await (await fetch(`${base}/api/biblioteca`, { headers: { 'x-visitante': visitor } })).json()) as Array<{ id: string; falhas: unknown[]; faixas: Array<{ arquivo: string }> }>;

  it('a playlist inteira sai num .zip; o botão baixa de novo só os que falharam, só para o dono', async () => {
    await downloader.download({ url: 'https://www.youtube.com/playlist?list=PL1', formato: 'mp3', playlist: true, userId: owner });
    const [entry] = await listFor(ANA);
    assert.equal(entry!.falhas.length, 1);
    assert.deepEqual(entry!.faixas.map((t) => t.arquivo), ['AAAAAAAAAAA.mp3', 'CCCCCCCCCCC.mp3']);

    const zip = await fetch(`${base}/api/biblioteca/${entry!.id}/zip`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get('content-disposition')!, /filename="Playlist de teste\.zip"/);
    assert.equal(Buffer.from(await zip.arrayBuffer()).toString('latin1', 0, 2), 'PK');

    const other = await fetch(`${base}/api/biblioteca/${entry!.id}/tentar-de-novo`, { method: 'POST', headers: { 'x-visitante': 'outro-visitante-00000000000001' } });
    assert.equal(((await other.json()) as { ok: boolean }).ok, false, 'só o dono');

    failing.clear();
    const retry = await fetch(`${base}/api/biblioteca/${entry!.id}/tentar-de-novo`, { method: 'POST', headers: { 'x-visitante': ANA } });
    assert.deepEqual(await retry.json(), { ok: true, novos: 1, falhas: [] });
    const [updated] = await listFor(ANA);
    assert.deepEqual([updated!.faixas.length, updated!.falhas.length], [3, 0]);
  });
});
