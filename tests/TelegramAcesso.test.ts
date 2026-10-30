import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Context } from 'grammy';
import { TelegramAccessGate } from '../src/canais/telegram/acesso/TelegramAccessGate.js';
import { TelegramAccessStore } from '../src/canais/telegram/acesso/TelegramAccessStore.js';
import { inviteLink, qrPng, qrTerminal } from '../src/canais/telegram/acesso/convite.js';
import { Config } from '../src/config/Config.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { parseManifest } from '../src/profiles/ProfileManifest.js';

const OWNER = 1;

/** Mensagem de mentira: o que o porteiro lê do contexto do grammy e o que ele responde. */
function message(userId: number, text = 'oi', name = 'Ana') {
  const replies: string[] = [];
  const ctx = {
    from: { id: userId, is_bot: false, first_name: name, username: name.toLowerCase() },
    chat: { id: userId, type: 'private' },
    message: { text },
    reply: async (t: string) => void replies.push(t),
  } as unknown as Context;
  return { ctx, replies };
}

function gate(mode: 'lista' | 'convite' | 'aberto', options: { requests?: boolean; hourlyLimit?: number } = {}) {
  const store = new TelegramAccessStore(DatabaseConnection.open(':memory:'));
  const sent: Array<{ to: number; text: string; buttons: boolean }> = [];
  const g = new TelegramAccessGate({
    store,
    owners: new Set([OWNER]),
    mode,
    requests: options.requests ?? mode === 'convite',
    hourlyLimit: options.hourlyLimit ?? 30,
    agentName: 'AgroMinds',
  }).attach({
    api: { sendMessage: async (to: number, text: string, extra: { reply_markup?: unknown }) => void sent.push({ to, text, buttons: Boolean(extra?.reply_markup) }) },
  } as never);
  const pass = async (userId: number, text?: string) => {
    const m = message(userId, text);
    let passed = false;
    await g.check(m.ctx, async () => void (passed = true));
    return { passed, replies: m.replies };
  };
  return { store, g, sent, pass };
}

describe('Acesso ao bot da fita', () => {
  it('modo lista (padrão): só os donos, os outros são ignorados em silêncio', async () => {
    const { pass } = gate('lista');
    assert.equal((await pass(OWNER)).passed, true);
    const stranger = await pass(99);
    assert.deepEqual(stranger, { passed: false, replies: [] });
  });

  it('convite: o link libera na hora, vale uma vez, e os donos ficam sabendo', async () => {
    const { store, sent, pass } = gate('convite');
    const invite = store.createInvite({ nome: 'Maria', dias: 7 });
    assert.match(invite.codigo, /^[A-Za-z0-9_-]{16}$/);

    const first = await pass(50, `/start ${invite.codigo}`);
    assert.equal(first.passed, true);
    assert.match(first.replies[0]!, /Acesso liberado/);
    assert.equal(store.get(50)?.status, 'ativo');
    assert.equal(store.get(50)?.origem, 'convite');
    assert.match(sent[0]!.text, /entrou pelo convite/);
    assert.equal((await pass(50, 'bom dia')).passed, true, 'depois, entra sem convite');

    // Uso único: a segunda pessoa vira pedido.
    const second = await pass(60, `/start ${invite.codigo}`);
    assert.equal(second.passed, false);
    assert.match(second.replies[0]!, /já foi usado/);
    assert.match(second.replies[1]!, /Pedido de acesso enviado/);
    assert.equal(store.get(60)?.status, 'pendente');
    assert.equal(sent.at(-1)!.buttons, true, 'dono recebe Aprovar/Recusar');

    // Convite inventado, vencido ou cancelado não libera.
    assert.equal(store.redeem('codigo-que-nao-existe', { id: 70, nome: 'X' }).ok, false);
    const revoked = store.createInvite();
    store.revokeInvite(revoked.codigo);
    assert.deepEqual(store.redeem(revoked.codigo, { id: 70, nome: 'X' }), { ok: false, motivo: 'revogado' });
  });

  it('convite: pedido fica esperando; aprovado entra, bloqueado nunca mais', async () => {
    const { store, sent, pass } = gate('convite');
    const asked = await pass(80, 'quero usar');
    assert.equal(asked.passed, false);
    assert.equal(sent.length, 1);
    // Insistir não gera outro pedido nem enche o chat de avisos.
    const again = await pass(80, 'oi?');
    assert.deepEqual(again.replies, []);
    assert.equal(sent.length, 1);

    store.setStatus(80, 'ativo');
    assert.equal((await pass(80)).passed, true);
    store.setStatus(80, 'bloqueado');
    assert.deepEqual(await pass(80, `/start ${store.createInvite().codigo}`), { passed: false, replies: [] }, 'bloqueado não volta nem com convite');
  });

  it('convite sem pedidos: quem não tem convite recebe o aviso uma vez', async () => {
    const { store, pass } = gate('convite', { requests: false });
    const first = await pass(90);
    assert.match(first.replies[0]!, /só para convidados/);
    assert.deepEqual((await pass(90)).replies, []);
    assert.equal(store.get(90), undefined);
  });

  it('aberto: qualquer um entra, com limite por hora', async () => {
    const { store, pass } = gate('aberto', { hourlyLimit: 2 });
    assert.equal((await pass(100)).passed, true);
    assert.equal(store.get(100)?.origem, 'aberto');
    assert.equal((await pass(100)).passed, true);
    const blocked = await pass(100);
    assert.equal(blocked.passed, false);
    assert.match(blocked.replies[0]!, /Limite de 2 mensagens/);
  });

  it('link e QR do convite', async () => {
    assert.equal(inviteLink('@agrominds_bot', 'abc123DEF456'), 'https://t.me/agrominds_bot?start=abc123DEF456');
    const png = await qrPng('https://t.me/x_bot?start=abc');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok((await qrTerminal('https://t.me/x_bot?start=abc')).split('\n').length > 10);
  });

  it('perfil.yaml: telegram.acesso vira a configuração do bot da fita', () => {
    const manifest = parseManifest('nome: x\ntelegram:\n  acesso: convite\n  pedidos: false\n  limite_hora: 10');
    assert.deepEqual(manifest.telegram, { acesso: 'convite', pedidos: false, limiteHora: 10 });
    assert.throws(() => parseManifest('nome: x\ntelegram: { acesso: todos }'), /telegram.acesso/);
    const base = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k' };
    assert.deepEqual(new Config(base).telegramAccess, { mode: 'lista', requests: false, hourlyLimit: 30 });
    assert.deepEqual(new Config({ ...base, TELEGRAM_ACESSO: 'convite' }).telegramAccess, { mode: 'convite', requests: true, hourlyLimit: 30 });
  });
});
