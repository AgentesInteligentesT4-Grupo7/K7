import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ResponseAttachments } from '../src/agent/ResponseAttachments.js';
import type { Core } from '../src/app/createCore.js';
import { WebChannel } from '../src/canais/web/WebChannel.js';
import { Config } from '../src/config/Config.js';
import { DocumentExtractor } from '../src/documents/DocumentExtractor.js';
import { UserFacingError } from '../src/errors/AppErrors.js';
import { ExtensionHost } from '../src/fitas/ExtensionHost.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { parseManifest } from '../src/profiles/ProfileManifest.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';

/** Extensão de exemplo: uma ferramenta, rotas (com e sem visitante, mídia, erros) e um painel. */
const EXTENSION = `
import fs from 'node:fs';
import path from 'node:path';

export default function ativar(k7) {
  k7.ferramenta({
    name: 'eco_fita',
    description: 'Devolve o texto',
    parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] },
    async run(args, ctx) {
      if (args.texto === 'falha') throw Object.assign(new Error('técnico'), { userMessage: 'Não deu: tente outro texto.' });
      ctx.anexarMidia(path.join(k7.fita.dir, 'som.mp3'), 'audio');
      return 'eco: ' + args.texto + ' de ' + (ctx.userId ?? '?');
    },
  });
  k7.web.rota('GET', /^\\/api\\/x\\/quem$/, (ctx) => ctx.json({ userId: ctx.userId, publico: ctx.publico }));
  k7.web.rota('GET', /^\\/api\\/x\\/som\\/(\\w+)$/, (ctx) => ctx.midia(path.join(k7.fita.dir, ctx.params[0] + '.mp3'), 'som.mp3'), { visitante: false });
  k7.web.rota('POST', /^\\/api\\/x\\/aviso$/, () => { throw Object.assign(new Error('x'), { userMessage: 'Formato não suportado.' }); });
  k7.web.rota('POST', /^\\/api\\/x\\/quebra$/, () => { throw new Error('bug'); });
  k7.web.rota('POST', /^\\/api\\/x\\/andamento$/, (ctx) => { ctx.progresso('Fazendo 1 de 2…', { done: 1, total: 2 }); ctx.json({ ok: true }); });
  k7.web.painel({ script: 'web/painel.js', estilo: 'web/painel.css' });
  k7.comando('oi', 'Diz oi', async () => {});
}
`;

function fitaDir(extension = EXTENSION): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fita-ext-'));
  fs.mkdirSync(path.join(dir, 'extensao'));
  fs.mkdirSync(path.join(dir, 'web'));
  fs.writeFileSync(path.join(dir, 'extensao', 'index.ts'), extension);
  fs.writeFileSync(path.join(dir, 'web', 'painel.js'), "window.painelOk = '</script>';");
  fs.writeFileSync(path.join(dir, 'web', 'painel.css'), '#painel { color: red; }');
  fs.writeFileSync(path.join(dir, 'som.mp3'), 'ID3-0123456789');
  return dir;
}

function configFor(dir: string): Config {
  return new Config(
    {
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_ALLOWED_USER_IDS: '1',
      GEMINI_API_KEY: 'k',
      DB_PATH: path.join(dir, 'a.db'),
      PERFIL_NOME: 'teste',
      PERFIL_DIR: dir,
      FITA_EXTENSAO: path.join(dir, 'extensao', 'index.ts'),
    },
    dir,
  );
}

describe('Extensão de fita: manifesto', () => {
  it('extensao é um arquivo .ts/.js dentro da fita', () => {
    assert.equal(parseManifest('nome: x\nextensao: extensao/index.ts').extensao, 'extensao/index.ts');
    assert.equal(parseManifest('nome: x\nextensao: extensao\\index.ts').extensao, 'extensao/index.ts');
    for (const bad of ['../fora.ts', '/abs/index.ts', 'C:/x/index.ts', 'extensao/run.py', '""']) {
      assert.throws(() => parseManifest(`nome: x\nextensao: ${bad}`), /campo "extensao"/, bad);
    }
  });
});

describe('Extensão de fita: ferramentas e comandos', () => {
  it('a ferramenta entra no agente; erro com userMessage chega à pessoa; mídia vai junto da resposta', async () => {
    const dir = fitaDir();
    const registry = new ToolRegistry();
    const host = new ExtensionHost(configFor(dir), registry);
    assert.equal(host.enabled, true);
    await host.load();
    assert.deepEqual(host.commands.map((c) => c.name), ['oi']);

    const tool = registry.get('eco_fita')!;
    const { result, media } = await ResponseAttachments.collect(() => tool.execute({ texto: 'oi' }));
    assert.equal(result.output, 'eco: oi de ?');
    assert.deepEqual(media, [{ path: path.join(dir, 'som.mp3'), kind: 'audio' }]);
    await assert.rejects(tool.execute({ texto: 'falha' }), (e: unknown) => e instanceof UserFacingError && e.userMessage === 'Não deu: tente outro texto.');
  });

  it('rota fora de /api/x/, painel fora da fita e extensão sem ativar() são recusados', async () => {
    const load = (code: string) => new ExtensionHost(configFor(fitaDir(code)), new ToolRegistry()).load();
    await assert.rejects(load("export default (k7) => k7.web.rota('GET', /^\\/api\\/info$/, () => {});"), /precisa começar com \/api\/x\//);
    await assert.rejects(load("export default (k7) => k7.web.painel({ script: '../fora.js' });"), /fora da fita/);
    await assert.rejects(load('export const x = 1;'), /export default function ativar/);
    // Sem extensão: nada a carregar.
    const plain = new ExtensionHost(new Config({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k' }, os.tmpdir()), new ToolRegistry());
    assert.equal(plain.enabled, false);
    await plain.load();
  });
});

describe('Extensão de fita: rotas e painel no chat web', () => {
  const dir = fitaDir();
  const VISITOR = 'visitante-ana-0000000000000001';
  let channel: WebChannel;
  let base = '';

  before(async () => {
    const config = configFor(dir);
    const tmp = new TempFileManager(path.join(dir, 'tmp'));
    tmp.initialize();
    const extensions = new ExtensionHost(config, new ToolRegistry());
    await extensions.load();
    const core = {
      config,
      tmp,
      memory: new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 }),
      llm: { name: 'falso', model: 'eco', providerNames: ['falso'] },
      tts: { name: 'tts', voice: 'v', synthesize: async () => ({ audio: Buffer.from(''), format: 'ogg' }) },
      stt: { transcribe: async () => '' },
      documents: new DocumentExtractor(),
      extensions,
      createController: () => ({ listSkills: () => [] }),
    } as unknown as Core;
    channel = new WebChannel(core, { host: '127.0.0.1', port: 0, userId: 'web', public: true });
    await channel.start();
    base = new URL(channel.url).origin;
  });
  after(() => channel.stop());

  const call = (route: string, method = 'GET', headers: Record<string, string> = { 'x-visitante': VISITOR }) => fetch(`${base}${route}`, { method, headers });

  it('rota com visitante recebe quem é; sem cabeçalho, 400; rota sem visitante serve mídia com Range', async () => {
    const who = (await (await call('/api/x/quem')).json()) as { userId: string; publico: boolean };
    assert.match(who.userId, /^web-[0-9a-f]{16}$/);
    assert.equal(who.publico, true);
    assert.equal((await call('/api/x/quem', 'GET', {})).status, 400);

    const part = await call('/api/x/som/som', 'GET', { range: 'bytes=4-7' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 4-7/14');
    assert.equal(await part.text(), '0123');
    assert.equal((await call('/api/x/nada')).status, 404);
  });

  it('erro com userMessage vira 422 com a mensagem; erro comum, 500 sem detalhes; andamento vai para /api/progresso', async () => {
    const warn = await call('/api/x/aviso', 'POST');
    assert.equal(warn.status, 422);
    assert.deepEqual(await warn.json(), { erro: 'Formato não suportado.' });
    const bug = await call('/api/x/quebra', 'POST');
    assert.equal(bug.status, 500);
    assert.doesNotMatch(JSON.stringify(await bug.json()), /bug/);

    await call('/api/x/andamento', 'POST');
    assert.deepEqual(await (await call('/api/progresso')).json(), { texto: 'Fazendo 1 de 2…', feitos: 1, total: 2 });
  });

  it('a página inclui o painel da fita com o nonce, depois do script da página, sem fechar a tag antes da hora', async () => {
    const page = await (await fetch(`${base}/`)).text();
    const nonce = /<script nonce="([^"]+)">/.exec(page)![1]!;
    assert.ok(page.includes(`<style nonce="${nonce}">\n#painel { color: red; }`));
    assert.ok(page.includes("window.painelOk = '<\\/script>';"));
    assert.ok(page.indexOf('window.K7 = {') < page.indexOf('window.painelOk'), 'o painel vem depois do window.K7');
  });
});
