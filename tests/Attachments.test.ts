import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OrchestratedLlmProvider } from '../src/llm/orchestration/OrchestratedLlmProvider.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import { OpenAICompatibleProvider } from '../src/llm/OpenAICompatibleProvider.js';
import type { ILlmProvider, LlmRequest } from '../src/llm/types.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { AttachmentService } from '../src/modules/anexos/AttachmentService.js';
import { AttachmentStore, kindOf, mimeOf } from '../src/modules/anexos/AttachmentStore.js';
import { createAttachmentTools } from '../src/modules/anexos/AttachmentTools.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function setup(llmAnswer = 'Total: R$ 42,90') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anexos-'));
  const store = new AttachmentStore(DatabaseConnection.open(':memory:'), dir);
  const requests: LlmRequest[] = [];
  const llm = {
    name: 'falso',
    model: 'visao',
    chat: async (request: LlmRequest) => (requests.push(request), { content: llmAnswer, toolCalls: [], providerName: 'falso', model: 'visao' }),
    healthCheck: async () => undefined,
  } as ILlmProvider;
  const service = new AttachmentService(store, llm, { inlineChars: 100, excerptChars: 40, maxImageBytes: 1024 });
  return { dir, store, service, requests };
}

describe('Anexos: biblioteca', () => {
  it('tipo e MIME pela extensão', () => {
    assert.deepEqual(['a.PNG', 'b.pdf', 'c.md', 'd.exe'].map((n) => kindOf(n)), ['image', 'pdf', 'text', 'other']);
    assert.equal(mimeOf('foto.jpeg'), 'image/jpeg');
  });

  it('salva no disco, deduplica pelo SHA-256 e isola por usuário', async () => {
    const { store, service, dir } = setup();
    const first = await service.ingest({ userId: 'u1', name: 'nota.md', mime: '', data: Buffer.from('# Ata\nDecisão: usar perfis.') });
    assert.equal(first.attachment.kind, 'text');
    assert.equal(first.attachment.mime, 'text/markdown');
    assert.ok(fs.existsSync(path.join(dir, first.attachment.path)));
    const again = await service.ingest({ userId: 'u1', name: 'copia.md', mime: '', data: Buffer.from('# Ata\nDecisão: usar perfis.') });
    assert.equal(again.duplicate, true);
    assert.equal(again.attachment.id, first.attachment.id);
    assert.equal(store.get('u2', first.attachment.id), undefined, 'outro usuário não enxerga');
    assert.deepEqual(store.list('u2'), []);
  });

  it('busca por palavra sem diferenciar acentos (FTS5) e só nos anexos do usuário', async () => {
    const { store, service } = setup();
    await service.ingest({ userId: 'u1', name: 'contrato.txt', mime: 'text/plain', data: Buffer.from('O prazo de entrega é de 30 dias. Multa de 2%.') });
    await service.ingest({ userId: 'u2', name: 'outro.txt', mime: 'text/plain', data: Buffer.from('prazo secreto de outra pessoa') });
    const hits = store.search('u1', 'prazo entrega');
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.snippet, /«prazo» de «entrega»/);
    assert.equal(store.search('u1', 'decisao').length, 0);
    await service.ingest({ userId: 'u1', name: 'decisao.txt', mime: 'text/plain', data: Buffer.from('Decisão tomada') });
    assert.equal(store.search('u1', 'decisao').length, 1, 'acento ignorado');
  });

  it('retenção: remove o que passou do prazo e o mais antigo quando passa da cota', async () => {
    const { store, service } = setup();
    const a = await service.ingest({ userId: 'u1', name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(600, 'a') });
    const b = await service.ingest({ userId: 'u1', name: 'b.txt', mime: 'text/plain', data: Buffer.alloc(600, 'b') });
    assert.equal(store.cleanup(90, 1000), 1, 'cota de 1000 bytes: sai o mais antigo');
    assert.equal(store.get('u1', a.attachment.id), undefined);
    assert.ok(store.get('u1', b.attachment.id));
  });
});

describe('Anexos: entrada do agente', () => {
  it('documento pequeno entra inteiro; grande vira trecho + referência; imagem vai como ImagePart', async () => {
    const { service } = setup();
    const small = await service.ingest({ userId: 'u1', name: 'p.txt', mime: 'text/plain', data: Buffer.from('curto') });
    const big = await service.ingest({ userId: 'u1', name: 'g.txt', mime: 'text/plain', data: Buffer.from('x'.repeat(500)) });
    const image = await service.ingest({ userId: 'u1', name: 'recibo.png', mime: 'image/png', data: PNG });
    const built = service.buildInput([small, big, image], 'compare');
    assert.match(built.text, /^compare\n\n\[Anexo #\d+: p\.txt · texto · 5 caracteres\]\ncurto/);
    assert.match(built.text, new RegExp(`x{40}\\n\\[\\.\\.\\. trecho inicial; leia o restante com ler_anexo\\(${big.attachment.id}\\)`));
    assert.ok(!built.text.includes('x'.repeat(41)));
    assert.match(built.text, /\[Anexo #\d+: recibo\.png · imagem\]/);
    assert.deepEqual(built.images, [{ mime: 'image/png', base64: PNG.toString('base64') }]);
    assert.equal(service.buildInput([image], '').text.split('\n')[0], 'Analise a imagem anexada.');
  });

  it('OCR por visão só quando pedido, com cache; análise usa contexto próprio de "visao"', async () => {
    const { service, store, requests } = setup('NOTA FISCAL\nTotal R$ 42,90');
    const { attachment } = await service.ingest({ userId: 'u1', name: 'nota.png', mime: 'image/png', data: PNG });
    assert.equal(requests.length, 0, 'ingestão não chama o LLM');
    await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: 'u1', pinned: 'modelo/sem-visao' }, async () => {
      const parts = await service.text('u1', attachment);
      assert.equal(parts[0]!.text, 'NOTA FISCAL\nTotal R$ 42,90');
      assert.equal(TaskContext.current()!.pinned, 'modelo/sem-visao', 'não troca o modelo fixado da conversa');
    });
    await service.text('u1', attachment);
    assert.equal(requests.length, 1, 'segunda leitura vem do cache');
    assert.equal(requests[0]!.messages[0]!.images?.[0]?.mime, 'image/png');
    assert.equal(store.search('u1', 'fiscal').length, 1, 'OCR entra na busca');
  });

  it('ferramentas usam o usuário da conversa e recusam anexo de outro', async () => {
    const { service } = setup('Há um gato na foto.');
    const mine = await service.ingest({ userId: 'u1', name: 'gato.png', mime: 'image/png', data: PNG });
    const [list, read, , analyze] = createAttachmentTools(service);
    await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: 'u1' }, async () => {
      assert.match((await list!.execute({})).output, /#\d+ · gato\.png · image/);
      assert.match((await analyze!.execute({ id: mine.attachment.id, pergunta: 'o que tem?' })).output, /gato na foto/);
      assert.match((await read!.execute({ id: mine.attachment.id })).output, /gato na foto/);
    });
    await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: 'u2' }, async () => {
      await assert.rejects(read!.execute({ id: mine.attachment.id }), /não encontrado/);
    });
  });
});

describe('Visão no LLM', () => {
  it('mensagem com imagem vira conteúdo multimodal (texto + image_url em data URI)', async () => {
    const realFetch = globalThis.fetch;
    let body: { messages: Array<{ content: unknown }> } | undefined;
    globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const provider = new OpenAICompatibleProvider({ name: 't', baseUrl: 'http://x', apiKey: 'k', model: 'm', timeoutMs: 1000, defaultTemperature: 0, retryDelaysMs: [] });
      await provider.chat({ messages: [{ role: 'user', content: 'o que é?', images: [{ mime: 'image/png', base64: 'AAA' }] }] });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(body!.messages[0]!.content, [
      { type: 'text', text: 'o que é?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('o orquestrador exige modelo com visão quando a mensagem tem imagem', () => {
    const req = OrchestratedLlmProvider.requirementsFor({ messages: [{ role: 'user', content: 'x', images: [{ mime: 'image/png', base64: 'A' }] }] });
    assert.equal(req.vision, true);
    assert.ok(req.minContext >= 1500);
    assert.equal(OrchestratedLlmProvider.requirementsFor({ messages: [{ role: 'user', content: 'x' }] }).vision, false);
  });
});
