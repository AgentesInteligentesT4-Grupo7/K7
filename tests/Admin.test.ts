import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AdminServer } from '../src/canais/admin/AdminServer.js';
import { FitaRunner } from '../src/canais/admin/FitaRunner.js';

const TOKEN = 'token-de-teste-0123456789abcdef';

describe('Página de administração das fitas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k7-admin-'));
  const perfis = path.join(root, 'perfis');
  const source = path.join(root, 'origem-com-codigo');
  // Processo de mentira no lugar do main.ts: avisa o endereço do chat web e fica rodando.
  const runner = new FitaRunner({
    rootDir: root,
    webPortBase: 9900,
    launch: (fita, port) =>
      spawn(process.execPath, ['-e', `console.log('🌐 Chat web: http://127.0.0.1:${port}/#t=abc'); console.log('fita ${fita}'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  let server: AdminServer;
  let base = '';
  const api = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: { 'x-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  before(async () => {
    fs.mkdirSync(path.join(perfis, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(perfis, 'demo', 'perfil.yaml'), '# fita de teste\nnome: demo\ndescricao: Demonstração\nidentidade: { nome: Demo, emoji: "🧪" }\ncanais: [terminal]\nmodulos: []\n');
    fs.mkdirSync(path.join(source, 'extensao'), { recursive: true });
    fs.writeFileSync(path.join(source, 'perfil.yaml'), 'nome: comcodigo\nextensao: extensao/index.ts\nmodulos: []\n');
    fs.writeFileSync(path.join(source, 'extensao', 'index.ts'), 'export default () => {};');
    server = new AdminServer({ port: 0, rootDir: root, env: { PERFIS_DIR: perfis, GEMINI_API_KEY: 'k' }, token: TOKEN, runner });
    await server.start();
    base = new URL(server.url).origin;
  });
  after(() => server.stop());

  it('só com o token e pelo próprio endereço; a página sai com CSP', async () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#t=/);
    assert.equal((await fetch(`${base}/api/fitas`)).status, 401);
    // Outro Host (DNS rebinding): recusado. (O fetch não deixa trocar o Host; vai pelo http.)
    const status = await new Promise<number>((resolve) =>
      http.get(`${base}/api/fitas`, { headers: { host: 'evil.example', 'x-token': TOKEN } }, (res) => resolve(res.statusCode!)),
    );
    assert.equal(status, 421);
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'nonce-/);
    // Pedido que muda algo sem JSON (formulário de outro site) é recusado.
    assert.equal((await fetch(`${base}/api/fitas/demo/ligar`, { method: 'POST', headers: { 'x-token': TOKEN } })).status, 415);
  });

  it('lista as fitas e muda vitrine e canais no perfil.yaml sem perder comentários', async () => {
    const [demo] = (await (await api('/api/fitas')).json()) as Array<{ nome: string; canais: string[]; vitrine: boolean; processo: { rodando: boolean } }>;
    assert.equal(demo!.nome, 'demo');
    assert.deepEqual(demo!.canais, ['terminal']);
    assert.equal((await api('/api/fitas/demo/manifesto', 'POST', { vitrine: true, canais: ['terminal', 'web'] })).status, 200);
    const yaml = fs.readFileSync(path.join(perfis, 'demo', 'perfil.yaml'), 'utf8');
    assert.match(yaml, /^# fita de teste$/m);
    assert.match(yaml, /^canais: \[terminal, web\]$/m);
    assert.match(yaml, /^vitrine: true$/m);
    assert.equal((await api('/api/fitas/demo/manifesto', 'POST', { canais: ['fax'] })).status, 400);
  });

  it('liga e desliga a fita, com o endereço do chat web e o log', async () => {
    const on = (await (await api('/api/fitas/demo/ligar', 'POST', {})).json()) as { rodando: boolean };
    assert.equal(on.rodando, true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const log = (await (await api('/api/fitas/demo/log')).json()) as { linhas: string[]; web: string };
    assert.equal(log.web, 'http://127.0.0.1:9900/#t=abc');
    assert.ok(log.linhas.includes('fita demo'));
    const off = (await (await api('/api/fitas/demo/desligar', 'POST', {})).json()) as { rodando: boolean };
    assert.equal(off.rodando, false);
  });

  it('cria fita nova; instala fita com código só depois de confirmar; remove pedindo o nome', async () => {
    assert.equal((await api('/api/fitas', 'POST', { nome: 'nova-fita' })).status, 200);
    assert.ok(fs.existsSync(path.join(perfis, 'nova-fita', 'perfil.yaml')));
    assert.equal((await api('/api/fitas', 'POST', { nome: 'Nome Ruim' })).status, 400);

    const ask = await api('/api/instalar', 'POST', { origem: source });
    assert.equal(ask.status, 409);
    assert.deepEqual(((await ask.json()) as { arquivos: string[] }).arquivos, ['extensao/index.ts']);
    assert.ok(!fs.existsSync(path.join(perfis, 'comcodigo')), 'sem confirmar, nada é instalado');
    const ok = (await (await api('/api/instalar', 'POST', { origem: source, confiar: true })).json()) as { nome: string; codigo: string[] };
    assert.deepEqual([ok.nome, ok.codigo], ['comcodigo', ['extensao/index.ts']]);

    const list = (await (await api('/api/fitas')).json()) as Array<{ nome: string; extensao: { ligada: boolean } | null; codigo: number }>;
    const installed = list.find((f) => f.nome === 'comcodigo')!;
    assert.deepEqual([installed.extensao, installed.codigo], [{ caminho: 'extensao/index.ts', ligada: true }, 1]);
    assert.equal((await api('/api/fitas/comcodigo/manifesto', 'POST', { extensaoLigada: false })).status, 200);
    assert.match(fs.readFileSync(path.join(perfis, 'comcodigo', 'perfil.yaml'), 'utf8'), /^# extensao: extensao\/index\.ts$/m);

    assert.equal((await api('/api/fitas/nova-fita', 'DELETE', { confirmacao: 'errado' })).status, 400);
    assert.equal((await api('/api/fitas/nova-fita', 'DELETE', { confirmacao: 'nova-fita' })).status, 200);
    assert.ok(!fs.existsSync(path.join(perfis, 'nova-fita')));
    assert.equal((await api('/api/fitas/nao-existe/log')).status, 404);
  });

  it('Telegram da fita: sem bot, mostra o modo e pede para conectar', async () => {
    const t = (await (await api('/api/fitas/demo/telegram')).json()) as { bot: unknown; modo: string; pessoas: unknown[]; gerenteConfigurado: boolean };
    assert.deepEqual([t.bot, t.modo, t.pessoas, t.gerenteConfigurado], [null, 'lista', [], false]);
    const noBot = await api('/api/fitas/demo/telegram/convites', 'POST', {});
    assert.equal(noBot.status, 400);
    assert.match(((await noBot.json()) as { erro: string }).erro, /ainda não tem bot/);
    assert.equal((await api('/api/fitas/demo/telegram/bot/token', 'POST', { token: 'invalido' })).status, 400);
    assert.equal((await api('/api/fitas/demo/telegram/bot/gerente', 'POST', {})).status, 400);
  });
});

describe('Página de administração: um bot por fita', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k7-admin-bot-'));
  const perfis = path.join(root, 'perfis');
  // Telegram de mentira: getMe diz quem é o bot.
  const telegram = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { id: 123, is_bot: true, first_name: 'K7', username: 'k7_bot' } }));
  });
  const runner = new FitaRunner({
    rootDir: root,
    webPortBase: 9950,
    launch: () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  let server: AdminServer;
  let base = '';
  const api = (route: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${route}`, { method, headers: { 'x-token': TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  before(async () => {
    await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
    const fita = (nome: string, canais: string, env?: string) => {
      fs.mkdirSync(path.join(perfis, nome), { recursive: true });
      fs.writeFileSync(path.join(perfis, nome, 'perfil.yaml'), `nome: ${nome}\ndescricao: Fita ${nome}\nidentidade: { nome: ${nome.toUpperCase()}, emoji: "🧪" }\ncanais: ${canais}\nmodulos: []\n`);
      if (env) fs.writeFileSync(path.join(perfis, nome, '.env'), env);
    };
    const token = 'TELEGRAM_BOT_TOKEN=123:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n';
    fita('agro', '[telegram, terminal]', token);
    fita('copia', '[telegram, terminal]', token);
    fita('videos', '[telegram, terminal]');
    fita('sotexto', '[terminal]');
    const apiRoot = `http://127.0.0.1:${(telegram.address() as { port: number }).port}`;
    server = new AdminServer({ port: 0, rootDir: root, env: { PERFIS_DIR: perfis, GEMINI_API_KEY: 'k', TELEGRAM_API_ROOT: apiRoot }, token: TOKEN, runner });
    await server.start();
    base = new URL(server.url).origin;
  });
  after(async () => {
    await runner.stopAll();
    await server.stop();
    telegram.close();
  });

  it('aponta fitas que dividem o bot e as sem bot; não liga uma fita com o bot de outra já ligada', async () => {
    assert.equal((await api('/api/fitas/agro/ligar', 'POST', {})).status, 200);
    const info = (await (await api('/api/bots')).json()) as { bots: Array<Record<string, unknown>>; semBot: string[]; gerenteConfigurado: boolean };
    assert.deepEqual(info, {
      bots: [{ id: '123', username: 'k7_bot', fitas: ['agro', 'copia'], ligadas: ['agro'], dividido: true }],
      semBot: ['videos'],
      gerenteConfigurado: false,
    });
    const r = await api('/api/fitas/copia/ligar', 'POST', {});
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { erro: string }).erro, /mesmo da "agro"[\s\S]*Crie um bot próprio para "copia"/);
    assert.equal(runner.state('agro').rodando, true, 'a outra continua respondendo');
  });
});
