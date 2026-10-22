import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AgentInput, IOutputHandler } from '../src/agent/types.js';
import type { Core } from '../src/app/createCore.js';
import { WebChannel } from '../src/canais/web/WebChannel.js';
import { Config } from '../src/config/Config.js';
import { DocumentExtractor } from '../src/documents/DocumentExtractor.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';

const TOKEN = 'token-de-teste-123';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
const memory = new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 });
const inputs: AgentInput[] = [];

/** Núcleo mínimo: o "agente" ecoa a entrada e salva na memória, como o AgentController real. */
function fakeCore(): Core {
  const config = new Config(
    { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k', DB_PATH: path.join(dir, 'agente.db'), AGENT_NAME: 'Teste', MODULES: 'arquivos' },
    dir,
  );
  const tmp = new TempFileManager(path.join(dir, 'tmp'));
  tmp.initialize();
  return {
    config,
    tmp,
    memory,
    llm: { name: 'falso', model: 'eco', providerNames: ['falso'] },
    tts: { name: 'tts', voice: 'v', synthesize: async () => ({ audio: Buffer.from('ogg'), format: 'ogg' }) },
    stt: { transcribe: async () => 'transcrito' },
    documents: new DocumentExtractor(),
    createController: (output: IOutputHandler) => ({
      async handle(input: AgentInput) {
        inputs.push(input);
        const conversation = memory.getOrCreateActiveConversation(String(input.userId), 'falso');
        memory.saveMessage(conversation.id, 'user', input.text);
        const text = input.text.startsWith('gere arquivo')
          ? 'Pronto <arquivo nome="nota.md">conteúdo da nota</arquivo>'
          : `eco: ${input.text.slice(0, 200)}`;
        memory.saveMessage(conversation.id, 'assistant', text);
        await output.send(input.chatId, { text, isAudio: input.requiresAudioReply });
      },
      newConversation: (userId: string) => memory.startNewConversation(String(userId), 'falso'),
      listSkills: () => [{ name: 'resumidor', description: 'Resume textos' }],
    }),
  } as unknown as Core;
}

let channel: WebChannel;
let base: string;

const api = (route: string, init: RequestInit & { token?: string | null } = {}) =>
  fetch(`${base}${route}`, {
    ...init,
    headers: {
      ...(init.token === null ? {} : { 'x-token': init.token ?? TOKEN }),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

describe('Canal web', () => {
  before(async () => {
    channel = new WebChannel(fakeCore(), { host: '127.0.0.1', port: 0, token: TOKEN, userId: 'web' });
    await channel.start();
    base = new URL(channel.url).origin;
  });
  after(() => channel.stop());

  it('a página sai com CSP por nonce e não exige token; o endereço traz o token no fragmento', async () => {
    const res = await api('/', { token: null });
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    const html = await res.text();
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.doesNotMatch(html, /__NONCE__/);
    assert.match(csp, /default-src 'none'/);
    assert.match(channel.url, new RegExp(`#t=${TOKEN}$`));
  });

  it('API sem token → 401; Host estranho (DNS rebinding) → 421', async () => {
    assert.equal((await api('/api/info', { token: null })).status, 401);
    assert.equal((await api('/api/info', { token: 'errado' })).status, 401);
    // fetch ignora o cabeçalho Host; http.request permite simular o ataque.
    const status = await new Promise<number>((resolve, reject) => {
      const { port } = new URL(base);
      http
        .request({ host: '127.0.0.1', port, path: '/api/info', headers: { host: 'site-malicioso.com', 'x-token': TOKEN } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject)
        .end();
    });
    assert.equal(status, 421);
  });

  it('mensagem de texto: resposta, modelo e canal "web"', async () => {
    const reply = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ texto: 'oi' }) })).json()) as Record<string, unknown>;
    assert.equal(reply.texto, 'eco: oi');
    assert.equal(reply.modelo, 'falso/eco');
    assert.equal(inputs.at(-1)!.channel, 'web');
    assert.equal(inputs.at(-1)!.requiresAudioReply, false);
  });

  it('pedido de áudio gera o arquivo de voz servido com o token na query', async () => {
    const reply = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ texto: 'olá', responderEmAudio: true }) })).json()) as {
      audios: Array<{ url: string }>;
    };
    assert.equal(reply.audios.length, 1);
    const audio = await api(`${reply.audios[0]!.url}?t=${TOKEN}`, { token: null });
    assert.equal(audio.headers.get('content-type'), 'audio/ogg');
    assert.equal(await audio.text(), 'ogg');
  });

  it('documento gerado vira link de download; nomes com caminho são recusados', async () => {
    const reply = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ texto: 'gere arquivo' }) })).json()) as {
      texto: string;
      arquivos: Array<{ nome: string; url: string }>;
    };
    assert.equal(reply.texto, 'Pronto');
    assert.equal(reply.arquivos[0]!.nome, 'nota.md');
    assert.equal(await (await api(reply.arquivos[0]!.url)).text(), 'conteúdo da nota');
    assert.equal((await api(`/api/arquivos/${encodeURIComponent('../agente.db')}`)).status, 404);
    assert.equal((await api('/api/arquivos/%2E%2E%5Cagente.db')).status, 404);
  });

  it('anexo .md é extraído para o agente; tipo não suportado e áudio sem voz dão aviso', async () => {
    const md = Buffer.from('# Ata\nDecidimos usar perfis.').toString('base64');
    const reply = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ texto: 'resuma', anexo: { nome: 'ata.md', base64: md } }) })).json()) as Record<string, unknown>;
    assert.match(String(reply.texto), /eco: resuma/);
    assert.match(inputs.at(-1)!.text, /\[Documento anexado: ata\.md\]\n# Ata\nDecidimos usar perfis\./);
    assert.equal(inputs.at(-1)!.source, 'document');
    const exe = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ anexo: { nome: 'x.exe', base64: 'AAAA' } }) })).json()) as Record<string, unknown>;
    assert.match(String(exe.erro), /^⚠️/);
    const empty = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ texto: '   ' }) })).json()) as Record<string, unknown>;
    assert.match(String(empty.erro), /Escreva uma mensagem/);
  });

  it('áudio gravado é transcrito e volta a transcrição', async () => {
    const reply = (await (await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ audio: { tipo: 'audio/webm;codecs=opus', base64: 'AAAA' } }) })).json()) as Record<string, unknown>;
    assert.equal(reply.transcricao, 'transcrito');
    assert.equal(inputs.at(-1)!.source, 'voice');
  });

  it('conversas: lista com título, nova conversa, reabrir e histórico só do próprio usuário', async () => {
    const list = (await (await api('/api/conversas')).json()) as Array<{ id: string; titulo: string; ativa: boolean }>;
    assert.equal(list[0]!.titulo, 'oi');
    assert.ok(list[0]!.ativa);
    const first = list[0]!.id;

    await api('/api/conversas', { method: 'POST' });
    await api('/api/mensagens', { method: 'POST', body: JSON.stringify({ texto: 'segunda conversa' }) });
    const after = (await (await api('/api/conversas')).json()) as Array<{ id: string; titulo: string; ativa: boolean }>;
    assert.equal(after.length, 2);
    assert.equal(after.find((c) => c.ativa)!.titulo, 'segunda conversa');

    assert.equal((await api(`/api/conversas/${first}/abrir`, { method: 'POST' })).status, 200);
    const history = (await (await api(`/api/conversas/${first}`)).json()) as Array<{ papel: string; texto: string }>;
    assert.equal(history[0]!.texto, 'oi');
    assert.ok(history.some((m) => m.texto === '📎 ata.md' || /resuma\n\n📎 ata\.md/.test(m.texto)), 'anexo aparece resumido no histórico');

    const other = memory.getOrCreateActiveConversation('outra-pessoa', 'x');
    assert.equal((await api(`/api/conversas/${other.id}/abrir`, { method: 'POST' })).status, 404);
    assert.deepEqual(await (await api(`/api/conversas/${other.id}`)).json(), []);
  });

  it('informações do agente para a página', async () => {
    const info = (await (await api('/api/info')).json()) as Record<string, unknown>;
    assert.equal(info.nome, 'Teste');
    assert.deepEqual(info.modulos, ['arquivos']);
    assert.equal(info.voz, false);
    assert.deepEqual(info.skills, [{ nome: 'resumidor', descricao: 'Resume textos' }]);
  });
});
