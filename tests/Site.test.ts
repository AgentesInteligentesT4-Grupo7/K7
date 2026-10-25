import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SiteServer, type RunningTape, type ShowcaseTape } from '../src/canais/site/SiteServer.js';
import { showcaseTapes } from '../src/canais/site/showcase.js';
import { parseManifest } from '../src/profiles/ProfileManifest.js';

const TAPES: ShowcaseTape[] = [{ nome: 'rebobina', titulo: 'Rebobina', emoji: '🎧', descricao: 'Baixa do YouTube' }];

describe('Site do K7', () => {
  let site: SiteServer;
  let base: string;
  const launches: Array<{ nome: string; port: number }> = [];
  const seen: Array<{ path: string; visitor?: string }> = [];
  const children: http.Server[] = [];
  let stopped = 0;

  before(async () => {
    site = new SiteServer({
      host: '127.0.0.1',
      port: 0,
      tapeBasePort: 18800 + Math.floor(Math.random() * 500),
      listTapes: () => TAPES,
      // "Chat da fita" de mentira: responde na porta pedida e ecoa o caminho e o visitante.
      launch: (nome, port): RunningTape => {
        launches.push({ nome, port });
        const child = http.createServer((req, res) => {
          seen.push({ path: req.url!, ...(req.headers['x-visitante'] ? { visitor: String(req.headers['x-visitante']) } : {}) });
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ fita: nome, caminho: req.url }));
        });
        child.listen(port, '127.0.0.1');
        children.push(child);
        return { port, stop: () => (stopped++, child.close()), onExit: () => undefined };
      },
      startTimeoutMs: 5_000,
    });
    await site.start();
    base = new URL(site.url).origin;
  });
  after(async () => {
    await site.stop();
    for (const child of children) child.close();
  });

  it('página com CSP por nonce e a vitrine só com as fitas liberadas', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const nonce = /'nonce-([^']+)'/.exec(page.headers.get('content-security-policy')!)![1]!;
    assert.ok((await page.text()).includes(`<script nonce="${nonce}">`));
    assert.deepEqual(await (await fetch(`${base}/api/fitas`)).json(), TAPES);
  });

  it('fita fora da vitrine não toca; sem barra final redireciona', async () => {
    assert.equal((await fetch(`${base}/api/fitas/pessoal/tocar`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/fita/pessoal/`)).status, 404);
    const redirect = await fetch(`${base}/fita/rebobina`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/fita/rebobina/');
  });

  it('encaixa a fita uma vez e repassa o chat pelo mesmo endereço, com o caminho e o visitante', async () => {
    const played = (await (await fetch(`${base}/api/fitas/rebobina/tocar`, { method: 'POST' })).json()) as { url: string };
    assert.equal(played.url, '/fita/rebobina/');
    const reply = (await (await fetch(`${base}/fita/rebobina/api/info?x=1`, { headers: { 'x-visitante': 'visitante-teste-0000000001' } })).json()) as Record<string, string>;
    assert.deepEqual(reply, { fita: 'rebobina', caminho: '/api/info?x=1' });
    assert.ok(seen.some((s) => s.path === '/api/info?x=1' && s.visitor === 'visitante-teste-0000000001'));
    await fetch(`${base}/fita/rebobina/`);
    assert.equal(launches.length, 1, 'um processo por fita');
  });

  it('desligar o site desliga as fitas', async () => {
    const other = new SiteServer({ host: '127.0.0.1', port: 0, tapeBasePort: 19400 + Math.floor(Math.random() * 300), listTapes: () => TAPES, launch: (nome, port) => {
      const child = http.createServer((_req, res) => res.writeHead(200).end('ok')).listen(port, '127.0.0.1');
      return { port, stop: () => (stopped++, child.close()), onExit: () => undefined };
    } });
    await other.start();
    await fetch(`${new URL(other.url).origin}/api/fitas/rebobina/tocar`, { method: 'POST' });
    const before = stopped;
    await other.stop();
    assert.equal(stopped, before + 1);
  });
});

describe('Vitrine das fitas', () => {
  it('só entram as fitas com vitrine: true; vitrine precisa ser booleano', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitrine-'));
    const write = (name: string, extra: string) => {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'perfil.yaml'), `nome: ${name}\ndescricao: Fita ${name}\nidentidade:\n  nome: ${name.toUpperCase()}\n  emoji: 🎵\nmodulos: [arquivos]\n${extra}`);
    };
    write('aberta', 'vitrine: true\n');
    write('pessoal', '');
    write('fechada', 'vitrine: false\n');
    assert.deepEqual(showcaseTapes({ PERFIS_DIR: dir }, dir), [{ nome: 'aberta', titulo: 'ABERTA', emoji: '🎵', descricao: 'Fita aberta' }]);
    assert.throws(() => parseManifest('nome: x\nmodulos: [arquivos]\nvitrine: sim\n'), /vitrine/);
  });
});
