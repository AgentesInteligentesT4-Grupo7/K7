import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ResponseAttachments } from '../src/agent/ResponseAttachments.js';
import type { LlmRequest } from '../src/llm/types.js';
import { CharacterReferenceFinder } from '../src/modules/imagens/CharacterReference.js';
import { ComfyUIClient } from '../src/modules/imagens/ComfyUIClient.js';
import { GenerateImageTool } from '../src/modules/imagens/GenerateImageTool.js';
import { ImageGenerator } from '../src/modules/imagens/ImageGenerator.js';
import type { SafeHttpClient } from '../src/net/SafeHttpClient.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const IMAGE = Buffer.alloc(5_000, 7);

/** SearXNG falso (categoria imagens) e downloads falsos: registra o que foi baixado. */
function setup(results: Array<{ img_src: string; url: string; title: string }>, llmReplies: string[]) {
  const downloaded: string[] = [];
  const searxQueries: string[] = [];
  const fetcher = (async (url: string) => (searxQueries.push(String(url)), json({ results }))) as typeof fetch;
  const http = {
    request: async (url: string) => {
      downloaded.push(url);
      if (url.includes('quebrada')) throw new Error('timeout');
      return { status: 200, url, contentType: 'image/png', body: IMAGE, truncated: false };
    },
  } as unknown as SafeHttpClient;
  const llm = new FakeLlmProvider(llmReplies.map((content) => ({ content })));
  const textSearch = { name: 'fake', search: async () => [{ titulo: 'Ben Tennyson', url: 'https://ben10.fandom.com/wiki/Ben', trecho: 'Ben usa camiseta branca com listra preta e o Omnitrix no pulso.', fonte: 'ben10.fandom.com' }] };
  const finder = new CharacterReferenceFinder({ searxngUrl: 'http://searx', http, llm, textSearch, fetcher });
  return { finder, downloaded, searxQueries, llm };
}

const RESULTS = [
  { img_src: 'https://http2.mlstatic.com/ben10-figurinhas.webp', url: 'https://loja.com/ben10', title: 'Kit figurinhas Ben 10' },
  { img_src: 'https://exemplo.com/quebrada.png', url: 'https://exemplo.com', title: 'Ben Tennyson fan art' },
  { img_src: 'https://static.wikia.nocookie.net/ben10/ben.png', url: 'https://ben10.fandom.com/wiki/Ben_Tennyson', title: 'Ben Tennyson (Original)' },
  { img_src: 'https://upload.wikimedia.org/flor.jpg', url: 'https://commons.wikimedia.org/flor', title: 'Flor amarela' },
];

describe('Referência de personagem antes de desenhar', () => {
  it('busca imagens (wiki primeiro, sem lojas nem resultados sem o nome), baixa até 2 e monta a ficha com visão', async () => {
    const { finder, downloaded, searxQueries, llm } = setup(RESULTS, ['{"reconhecido": true, "tags": "10-year-old boy, brown spiky hair, green eyes, white t-shirt with black stripe, green cargo pants, green omnitrix watch on left wrist"}']);
    const ref = await finder.find('Ben Tennyson (Ben 10)');
    assert.match(searxQueries[0]!, /categories=images/);
    assert.deepEqual(downloaded, ['https://static.wikia.nocookie.net/ben10/ben.png', 'https://exemplo.com/quebrada.png'], 'wiki primeiro; loja e resultado sem o nome ficam de fora');
    assert.equal(ref.imagesUsed, 1);
    assert.match(ref.tags, /omnitrix/);
    assert.deepEqual(ref.sources, ['https://ben10.fandom.com/wiki/Ben_Tennyson', 'https://ben10.fandom.com/wiki/Ben']);
    const request = llm.requests[0] as LlmRequest;
    assert.equal(request.messages[0]!.images?.length, 1, 'a imagem de referência vai para o modelo com visão');
    assert.match(request.messages[0]!.content!, /Ben usa camiseta branca/);
    await finder.find('ben tennyson (BEN 10)');
    assert.equal(llm.requests.length, 1, 'mesmo personagem: usa o cache');
  });

  it('sem referência confiável recusa em vez de inventar', async () => {
    const notRecognized = setup(RESULTS, ['{"reconhecido": false, "tags": ""}']);
    await assert.rejects(notRecognized.finder.find('Ben Tennyson (Ben 10)'), /não mostram "Ben Tennyson \(Ben 10\)" com segurança/);
    const nothing = new CharacterReferenceFinder({
      searxngUrl: 'http://searx',
      http: { request: async () => ({}) } as unknown as SafeHttpClient,
      llm: new FakeLlmProvider([]),
      fetcher: (async () => json({ results: [] })) as typeof fetch,
    });
    await assert.rejects(nothing.find('Personagem Inexistente'), /Não encontrei referências de "Personagem Inexistente"/);
  });

  it('gerar_imagem com "personagem": a ficha entra no prompt antes da cena; sem a pesquisa web, recusa', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    let polls = 0;
    const comfy = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/object_info/CheckpointLoaderSimple')) return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['animagine-xl-4.0-opt.safetensors']] } } } });
      if (url.endsWith('/prompt')) return json({ prompt_id: 'p1' });
      if (url.includes('/history/p1')) return json(++polls < 2 ? {} : { p1: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } });
      if (url.includes('/view?')) return new Response(Buffer.from([0x89, 0x50]));
      return json({});
    }) as typeof fetch;
    const generator = new ImageGenerator({ comfy: new ComfyUIClient('http://comfy', comfy), outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ref-')), models: {}, defaultStyle: 'hq', quality: 'rapido', timeoutMs: 5000, idleUnloadMs: 0 });
    const { finder } = setup(RESULTS, ['{"reconhecido": true, "tags": "brown spiky hair, white t-shirt with black stripe, green omnitrix watch"}']);
    const tool = new GenerateImageTool(generator, os.tmpdir(), undefined, finder);
    const { result } = await ResponseAttachments.collect(() => tool.execute({ personagem: 'Ben Tennyson (Ben 10)', descricao: 'running in a park, smiling, full body', estilo: 'anime' }));
    const positive = String((calls.find((c) => c.url.endsWith('/prompt'))!.body as { prompt: Record<string, { inputs: { text?: string } }> }).prompt['6']!.inputs.text);
    assert.match(positive, /Ben Tennyson \(Ben 10\), brown spiky hair, white t-shirt with black stripe, green omnitrix watch, running in a park/);
    const output = JSON.parse(result.output) as { referencia: { fontes: string[] } };
    assert.ok(output.referencia.fontes.length > 0);
    await assert.rejects(new GenerateImageTool(generator, os.tmpdir()).execute({ personagem: 'Ben Tennyson (Ben 10)', descricao: 'x' }), /módulo "pesquisa-web" está desligado/);
  });
});
