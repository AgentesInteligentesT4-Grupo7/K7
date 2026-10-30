import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Bot } from 'grammy';
import { Config } from '../src/config/Config.js';
import { ExtensionHost } from '../src/fitas/ExtensionHost.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';

/** Fita com tarefa, banco próprio e Telegram (comando, localização, botões). */
const EXTENSION = `
export default function ativar(k7) {
  k7.sql.exec('CREATE TABLE IF NOT EXISTS lugares (user_id TEXT PRIMARY KEY, lat REAL, lon REAL)');
  globalThis.__execucoes = 0;
  k7.tarefa('boletim', 60 * 60_000, () => { globalThis.__execucoes++; });
  k7.telegram.comando('clima', 'Tempo agora', (ctx) => ctx.responder({ texto: 'Clima de ' + ctx.nome + (ctx.args ? ' em ' + ctx.args : ''), botoes: [[{ texto: 'Amanhã', dados: 'agro:amanha' }]] }));
  k7.telegram.comando('start', 'Começar', (ctx) => ctx.responder({ texto: 'Mande sua localização', pedirLocalizacao: '📍 Enviar localização' }));
  k7.telegram.aoLocalizacao((ctx) => {
    k7.sql.run('INSERT OR REPLACE INTO lugares VALUES (?, ?, ?)', ctx.userId, ctx.lat, ctx.lon);
    return ctx.responder('Lugar salvo');
  });
  k7.telegram.botoes('agro', (ctx) => ctx.editar('Você tocou em ' + ctx.dados));
  k7.telegram.comando('quebra', 'Erro', () => { throw Object.assign(new Error('x'), { userMessage: 'Sem previsão agora.' }); });
  globalThis.__k7 = k7;
}
`;

function host(principal: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fita-tg-'));
  fs.mkdirSync(path.join(dir, 'extensao'));
  fs.writeFileSync(path.join(dir, 'extensao', 'index.ts'), EXTENSION);
  const config = new Config(
    { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k', DB_PATH: path.join(dir, 'dados', 'agente.db'), PERFIL_NOME: 'agro', PERFIL_DIR: dir, FITA_EXTENSAO: path.join(dir, 'extensao', 'index.ts') },
    dir,
  );
  return { dir, extension: new ExtensionHost(config, new ToolRegistry(), { principal }) };
}

/** Bot de mentira: as chamadas à API do Telegram ficam numa lista e respondem "ok". */
function fakeBot() {
  const bot = new Bot('1:fake', { botInfo: { id: 2, is_bot: true, first_name: 'Agro', username: 'agro_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage' && (payload as { chat_id: number }).chat_id === 404) return { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } as never;
    return { ok: true, result: method === 'getMe' ? { username: 'agro_bot' } : true } as never;
  });
  let id = 1;
  const from = { id: 50, is_bot: false, first_name: 'Ana' };
  const chat = { id: 50, type: 'private' as const, first_name: 'Ana' };
  const send = (message: Record<string, unknown>) => bot.handleUpdate({ update_id: id++, message: { message_id: id, date: 0, chat, from, ...message } } as never);
  const tap = (data: string) => bot.handleUpdate({ update_id: id++, callback_query: { id: String(id), from, chat_instance: 'x', data, message: { message_id: 1, date: 0, chat, text: 'msg' } } } as never);
  return { bot, calls, send, tap };
}

describe('Extensão de fita: tarefas, banco próprio e Telegram', () => {
  it('tarefa só roda no processo principal; o banco da fita fica em dados/<fita>.db', async () => {
    const other = host(false);
    await other.extension.load();
    await other.extension.start();
    assert.equal((globalThis as { __execucoes?: number }).__execucoes, 0, 'chat web/terminal não rodam tarefas');
    other.extension.stop();

    const main = host(true);
    await main.extension.load();
    await main.extension.start();
    assert.equal((globalThis as { __execucoes?: number }).__execucoes, 1, 'roda logo ao iniciar');
    main.extension.stop();
    assert.ok(fs.existsSync(path.join(main.dir, 'dados', 'agro.db')));
  });

  it('comandos, localização e botões chegam à fita; o /start da fita vem antes; o menu lista os comandos', async () => {
    const { extension, dir } = host(false);
    await extension.load();
    const { bot, calls, send, tap } = fakeBot();
    extension.telegram.register(bot);
    extension.telegram.attach(bot.api);
    bot.command('start', (ctx) => ctx.reply('start do tocador')); // registrado depois: não deve responder

    assert.deepEqual(extension.telegram.menu().map((c) => c.command), ['clima', 'quebra']);
    await send({ text: '/clima Goiânia', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    const clima = calls.find((c) => c.method === 'sendMessage')!;
    assert.equal(clima.payload.text, 'Clima de Ana em Goiânia');
    assert.ok(JSON.stringify(clima.payload.reply_markup).includes('agro:amanha'));

    calls.length = 0;
    await send({ text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
    assert.deepEqual(calls.map((c) => c.payload.text), ['Mande sua localização']);
    assert.ok(JSON.stringify(calls[0]!.payload.reply_markup).includes('request_location'));

    calls.length = 0;
    await send({ location: { latitude: -16.68, longitude: -49.25 } });
    assert.equal(calls[0]!.payload.text, 'Lugar salvo');
    const k7 = (globalThis as unknown as { __k7: { sql: { get(sql: string, ...p: unknown[]): unknown } } }).__k7;
    assert.deepEqual(k7.sql.get('SELECT lat, lon FROM lugares WHERE user_id = ?', '50'), { lat: -16.68, lon: -49.25 });

    calls.length = 0;
    await tap('agro:amanha');
    assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'editMessageText']);
    assert.equal(calls[1]!.payload.text, 'Você tocou em agro:amanha');

    calls.length = 0;
    await send({ text: '/quebra', entities: [{ type: 'bot_command', offset: 0, length: 7 }] });
    assert.equal(calls[0]!.payload.text, '⚠️ Sem previsão agora.');

    // Notificação (sem ser resposta): entregue ou o motivo de não ter chegado.
    assert.deepEqual(await extension.telegram.notify('50', 'Alerta de geada'), { entregue: true });
    assert.deepEqual(await extension.telegram.notify('404', 'oi'), { entregue: false, erro: 'Forbidden: bot was blocked by the user' });
    extension.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imagem: SVG vira PNG; foto com legenda, e legenda longa vai numa mensagem depois da foto', async () => {
    const { extension, dir } = host(false);
    await extension.load();
    const k7 = (globalThis as unknown as { __k7: { util: { svgParaPng(svg: string): Promise<Buffer> } } }).__k7;
    const png = await k7.util.svgParaPng('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#2e7d32"/><text x="8" y="28" font-size="20" fill="#fff">24°C</text></svg>');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');

    const { bot, calls } = fakeBot();
    extension.telegram.attach(bot.api);
    assert.deepEqual(await extension.telegram.notify('50', { texto: 'Boletim', imagem: png }), { entregue: true });
    assert.deepEqual(calls.map((c) => c.method), ['sendPhoto']);
    assert.equal(calls[0]!.payload.caption, 'Boletim');
    calls.length = 0;
    await extension.telegram.notify('50', { texto: 'x'.repeat(1500), imagem: png });
    assert.deepEqual(calls.map((c) => c.method), ['sendPhoto', 'sendMessage']);
    extension.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
