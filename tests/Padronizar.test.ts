import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AudioLeveler } from '../src/modules/midia/AudioLeveler.js';
import { MediaDownloader } from '../src/modules/midia/MediaDownloader.js';
import { MediaLibrary } from '../src/modules/midia/MediaLibrary.js';
import type { YtdlpClient } from '../src/modules/midia/YtdlpClient.js';

/** Nome padronizado que o serviço de mentira devolve para cada nome atual. */
const NAMES: Record<string, string> = {
  'Banda - Musica (2).mp3': 'Musica - Banda.mp3',
  'Banda - Musica (Official Video).mp3': 'Musica - Banda.mp3',
  'Outra - Faixa.mp3': 'Faixa - Outra.mp3',
  'Faixa - Outra.mp3': 'Faixa - Outra.mp3',
};

/** /padronizar de mentira: 204 quando o nome já está certo (etiquetas certas); senão devolve o arquivo "etiquetado". */
function fakeService(): http.Server {
  return http.createServer((req, res) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('nome') ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const target = NAMES[name] ?? name;
      const headers = { 'x-nome': encodeURIComponent(target), 'x-titulo': 'T', 'x-artista': 'A' };
      if (target === name) return void res.writeHead(204, headers).end();
      res.writeHead(200, headers).end(Buffer.concat([Buffer.from('TAG:'), ...chunks]));
    });
  });
}

describe('Padronização dos nomes', () => {
  it('pasta de downloads: renomeia, une as repetidas (sem "(2)") e o índice e a biblioteca acompanham', async () => {
    const service = fakeService();
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
    const leveler = new AudioLeveler({ baseUrl: `http://127.0.0.1:${(service.address() as AddressInfo).port}`, timeoutMs: 5_000 });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padronizar-'));
      const downloads = path.join(dir, 'downloads');
      fs.mkdirSync(downloads);
      for (const name of ['Banda - Musica (2).mp3', 'Banda - Musica (Official Video).mp3', 'Outra - Faixa.mp3']) fs.writeFileSync(path.join(downloads, name), name);
      fs.writeFileSync(path.join(downloads, '.k7-indice.json'), JSON.stringify({ 'AAAAAAAAAAA.mp3': 'Banda - Musica (2).mp3', 'BBBBBBBBBBB.mp3': 'Banda - Musica (Official Video).mp3' }));
      const library = new MediaLibrary(dir);
      const entry = library.add('ana', {
        titulo: 'Lista',
        url: 'https://youtu.be/x',
        formato: 'mp3',
        arquivos: ['Banda - Musica (2).mp3', 'Banda - Musica (Official Video).mp3', 'Outra - Faixa.mp3'].map((f) => path.join(downloads, f)),
      })!;

      const downloader = new MediaDownloader({} as YtdlpClient, dir, library);
      const result = await downloader.standardizeAll(leveler);
      assert.deepEqual({ ...result, problems: result.problems.length }, { total: 3, renamed: 2, merged: 1, problems: 0 });
      assert.deepEqual(fs.readdirSync(downloads).filter((f) => !f.startsWith('.')).sort(), ['Faixa - Outra.mp3', 'Musica - Banda.mp3']);
      assert.match(fs.readFileSync(path.join(downloads, 'Musica - Banda.mp3'), 'utf8'), /^TAG:/, 'etiquetas gravadas');

      const index = JSON.parse(fs.readFileSync(path.join(downloads, '.k7-indice.json'), 'utf8')) as Record<string, string>;
      assert.deepEqual(index, { 'AAAAAAAAAAA.mp3': 'Musica - Banda.mp3', 'BBBBBBBBBBB.mp3': 'Musica - Banda.mp3' }, 'os dois IDs apontam para o que ficou');
      const tracks = library.get('ana', entry.id)!.faixas;
      assert.deepEqual(tracks.map((t) => t.arquivo), ['Musica - Banda.mp3', 'Faixa - Outra.mp3'], 'a repetida some da playlist');

      // Rodar de novo não muda nada (o serviço responde 204 para quem já está padronizado).
      const again = await downloader.standardizeAll(leveler);
      assert.deepEqual({ renamed: again.renamed, merged: again.merged }, { renamed: 0, merged: 0 });
    } finally {
      service.close();
    }
  });
});
