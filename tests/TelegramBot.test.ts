import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FitaTelegram } from '../src/canais/telegram/configuracao/FitaTelegram.js';
import { TelegramBotSetup, managedBotLink, setEnvVariable, suggestUsername } from '../src/canais/telegram/configuracao/TelegramBotSetup.js';

const FITA_TOKEN = '111:fita';
const MANAGER_TOKEN = '999:gerente';
const NEW_TOKEN = '222:novo';

/** API do Telegram de mentira: guarda as chamadas e responde como o Telegram. */
function fakeTelegram() {
  const calls: Array<{ token: string; method: string; body: string }> = [];
  let managedSent = false;
  const server = http.createServer((req, res) => {
    const [, bot, method] = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? '') ?? [];
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ token: bot!, method: method!, body });
      const ok = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
      if (method === 'getMe') {
        if (bot === MANAGER_TOKEN) return ok({ id: 9, is_bot: true, first_name: 'Gerente', username: 'k7_gerente_bot', can_manage_bots: true });
        if (bot === FITA_TOKEN || bot === NEW_TOKEN) return ok({ id: 2, is_bot: true, first_name: 'Fita', username: 'demo_fita_bot' });
        return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
      }
      if (method === 'getUpdates') {
        if (managedSent) return ok([]);
        managedSent = true;
        return ok([
          { update_id: 10, managed_bot: { user: { id: 555, is_bot: false, first_name: 'Estranho' }, bot: { id: 3, is_bot: true, first_name: 'X', username: 'x_bot' } } },
          { update_id: 11, managed_bot: { user: { id: 1, is_bot: false, first_name: 'Dono' }, bot: { id: 2, is_bot: true, first_name: 'Demo', username: 'demo_fita_bot' } } },
        ]);
      }
      if (method === 'getManagedBotToken') return ok(NEW_TOKEN);
      if (method === 'setMyProfilePhoto') return ok(true);
      ok(true);
    });
  });
  return { server, calls };
}

describe('Bot do Telegram da fita: criar e configurar', () => {
  const { server, calls } = fakeTelegram();
  let apiRoot = '';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'k7-bot-'));
  const perfis = path.join(root, 'perfis');
  const fitaDir = path.join(perfis, 'demo');
  let env: NodeJS.ProcessEnv;

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fs.mkdirSync(path.join(fitaDir, 'bot'), { recursive: true });
    fs.writeFileSync(path.join(fitaDir, 'perfil.yaml'), 'nome: demo\ndescricao: Fita de demonstração.\nidentidade: { nome: Demo, emoji: "🧪", proposito: testar o K7 }\ncanais: [telegram, terminal]\nmodulos: []\n');
    fs.writeFileSync(path.join(fitaDir, '.env.example'), '# Token do bot\nTELEGRAM_BOT_TOKEN=\nOUTRA=1\n');
    fs.writeFileSync(path.join(fitaDir, 'bot', 'foto.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    env = { PERFIS_DIR: perfis, GEMINI_API_KEY: 'k', TELEGRAM_ALLOWED_USER_IDS: '1', TELEGRAM_API_ROOT: apiRoot };
  });
  after(() => server.close());

  it('username sugerido e link do gerente', () => {
    assert.equal(suggestUsername('agrominds'), 'agrominds_bot');
    assert.equal(suggestUsername('Minha Fita!'), 'minha_fita_bot');
    assert.equal(managedBotLink('@k7_gerente_bot', 'agrominds_bot', 'AgroMinds 🌱'), 'https://t.me/newbot/k7_gerente_bot/agrominds_bot?name=AgroMinds%20%F0%9F%8C%B1');
  });

  it('.env da fita: grava o token sem mexer no resto (começa pelo .env.example)', () => {
    const file = path.join(root, 'teste.env');
    const example = path.join(root, 'exemplo.env');
    fs.writeFileSync(example, '# comentário\nTELEGRAM_BOT_TOKEN=\nA=1\n');
    setEnvVariable(file, 'TELEGRAM_BOT_TOKEN', '123:abc', example);
    assert.equal(fs.readFileSync(file, 'utf8'), '# comentário\nTELEGRAM_BOT_TOKEN=123:abc\nA=1\n');
    setEnvVariable(file, 'TELEGRAM_BOT_TOKEN', '456:def');
    setEnvVariable(file, 'NOVA', 'x');
    assert.equal(fs.readFileSync(file, 'utf8'), '# comentário\nTELEGRAM_BOT_TOKEN=456:def\nA=1\nNOVA=x\n');
  });

  it('conectar pelo token: confere, grava no .env e aplica nome, descrições, comandos e foto', async () => {
    const telegram = new FitaTelegram('demo', { env, rootDir: root });
    await assert.rejects(telegram.connectToken('000:invalido'), /Unauthorized/);
    assert.ok(!fs.existsSync(path.join(fitaDir, '.env')), 'token inválido não é gravado');

    calls.length = 0;
    const result = await telegram.connectToken(FITA_TOKEN);
    assert.equal(result.bot.username, 'demo_fita_bot');
    assert.match(fs.readFileSync(path.join(fitaDir, '.env'), 'utf8'), /^TELEGRAM_BOT_TOKEN=111:fita$/m);
    assert.deepEqual(result.falhas, []);
    assert.deepEqual(result.feitos, ['nome', 'descrição', 'descrição curta', 'comandos', 'comandos do dono 1', 'foto']);
    const name = calls.find((c) => c.method === 'setMyName')!;
    assert.match(name.body, /🧪 Demo/);
    assert.match(calls.find((c) => c.method === 'setMyDescription')!.body, /testar o K7/);
    assert.match(calls.find((c) => c.method === 'setMyCommands' && c.body.includes('convite'))!.body, /chat_id/, 'donos com /convite no chat deles');
  });

  it('criar pelo gerente: link, espera a confirmação de um dono e pega o token', async () => {
    const telegram = new FitaTelegram('demo', { env: { ...env, TELEGRAM_BOT_TOKEN: '' }, rootDir: root });
    await assert.rejects(new TelegramBotSetup({ apiRoot }).info('000:x'), /Unauthorized/);
    const { link, gerente } = await telegram.managedLink(MANAGER_TOKEN);
    assert.equal(gerente.podeGerenciar, true);
    assert.equal(link, 'https://t.me/newbot/k7_gerente_bot/demo_bot?name=Demo');

    calls.length = 0;
    const created = await telegram.completeManaged(MANAGER_TOKEN, 5_000);
    assert.equal(created.token, NEW_TOKEN);
    assert.equal(created.criadoPor.id, 1, 'o bot criado por quem não é dono é ignorado');
    assert.match(calls.find((c) => c.method === 'getManagedBotToken')!.body, /"user_id":2/);
    assert.match(fs.readFileSync(path.join(fitaDir, '.env'), 'utf8'), /^TELEGRAM_BOT_TOKEN=222:novo$/m);
  });

  it('gerente sem permissão de criar bots: explica o que ligar', async () => {
    const telegram = new FitaTelegram('demo', { env, rootDir: root });
    await assert.rejects(telegram.managedLink(FITA_TOKEN), /modo de gerenciar bots/);
  });

  it('convite com link e QR, e aviso quando a fita ainda está no modo lista', async () => {
    const telegram = new FitaTelegram('demo', { env, rootDir: root });
    const { link, png, aviso } = await telegram.invite({ nome: 'Maria' });
    assert.match(link, /^https:\/\/t\.me\/demo_fita_bot\?start=[A-Za-z0-9_-]{16}$/);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.match(aviso!, /modo "lista"/);
    const view = telegram.overview();
    assert.equal(view.convites.length, 1);
    assert.equal(view.convites[0]!.nome, 'Maria');
  });
});
