import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ResponseAttachments } from '../src/agent/ResponseAttachments.js';
import type { LlmRequest } from '../src/llm/types.js';
import { CharacterReferenceFinder } from '../src/modules/imagens/CharacterReference.js';
import { CharacterSheets } from '../src/modules/imagens/CharacterSheets.js';
import { ComfyUIClient, generationWorkflow } from '../src/modules/imagens/ComfyUIClient.js';
import { ImageJudge } from '../src/modules/imagens/ImageJudge.js';
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
    const { finder, downloaded, searxQueries, llm } = setup(RESULTS, ['{"reconhecido": true, "tags": "10-year-old boy, brown spiky hair, green eyes, white t-shirt with black stripe, green cargo pants, green omnitrix watch on left wrist", "referencias_boas": [1]}']);
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
    const { finder, llm } = setup(RESULTS, ['{"reconhecido": true, "tags": "brown spiky hair, white t-shirt with black stripe, green omnitrix watch", "danbooru": "ben tennyson, ben 10", "referencias_boas": [1]}']);
    const sheets = new CharacterSheets(fs.mkdtempSync(path.join(os.tmpdir(), 'fichas-')));
    const tool = new GenerateImageTool(generator, os.tmpdir(), { references: finder, sheets, candidates: 1 });
    const { result } = await ResponseAttachments.collect(() => tool.execute({ personagem: 'Ben Tennyson (Ben 10)', descricao: 'running in a park, smiling, full body', estilo: 'anime' }));
    const positive = String((calls.find((c) => c.url.endsWith('/prompt'))!.body as { prompt: Record<string, { inputs: { text?: string } }> }).prompt['6']!.inputs.text);
    assert.match(positive, /ben tennyson, ben 10, brown spiky hair, white t-shirt with black stripe, green omnitrix watch, running in a park/, 'no anime, a tag do Danbooru vem primeiro');
    const output = JSON.parse(result.output) as { fichas: string[]; fichas_criadas: Array<{ ficha: string }> };
    assert.deepEqual([output.fichas, output.fichas_criadas[0]!.ficha], [['ben-tennyson'], 'ben-tennyson'], 'a ficha é salva no primeiro uso');
    assert.deepEqual([sheets.get('Ben Tennyson')?.obra, sheets.images(sheets.get('ben-tennyson')!).length], ['Ben 10', 1]);

    // Segundo desenho: usa a ficha salva, sem buscar de novo (mesmo rosto e corpo em toda a história).
    await ResponseAttachments.collect(() => tool.execute({ fichas: 'ben-tennyson', descricao: 'sitting on a bench', estilo: 'hq' }));
    assert.equal(llm.requests.length, 1, 'não buscou referência de novo');
    const second = String((calls.filter((c) => c.url.endsWith('/prompt')).at(-1)!.body as { prompt: Record<string, { inputs: { text?: string } }> }).prompt['6']!.inputs.text);
    assert.match(second, /Ben Tennyson, brown spiky hair, .*sitting on a bench/, 'fora do anime, o nome em vez da tag');
    await assert.rejects(tool.execute({ fichas: 'ninguem', descricao: 'x' }), /Ficha "ninguem" não existe/);
    await assert.rejects(new GenerateImageTool(generator, os.tmpdir()).execute({ personagem: 'Ben Tennyson (Ben 10)', descricao: 'x' }), /módulo "pesquisa-web" está desligado/);
  });
});

describe('Fases do personagem', () => {
  it('cada fase é uma ficha; com várias fases salvas e sem "fase", pede para escolher; fase nova busca com a fase', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fases-'));
    const sheets = new CharacterSheets(dir);
    const img = { mime: 'image/png', base64: Buffer.from('x').toString('base64') };
    const jovem = sheets.save({ nome: 'Nie Li', obra: 'Tales of Demons and Gods', fase: 'jovem', tags: 'teen boy', origem: 'internet' }, [img, img, img, img, img]);
    sheets.save({ nome: 'Nie Li', obra: 'Tales of Demons and Gods', fase: 'adulto', tags: 'adult man', origem: 'internet' }, [img]);
    assert.equal(jovem.id, 'nie-li-jovem');
    assert.equal(sheets.images(jovem).length, 4, 'até 4 referências por fase');
    assert.deepEqual(sheets.phases('Nie Li').map((s) => s.fase).sort(), ['adulto', 'jovem']);

    const calls: string[] = [];
    const finder = { find: async (character: string, phase?: string) => (calls.push(`${character}|${phase}`), { character, tags: 'old man', sources: [], imagesUsed: 1, images: [img] }) };
    const generated: Array<{ description: string; references?: unknown[] }> = [];
    const generator = { generate: async (r: { description: string; references?: unknown[] }) => (generated.push(r), { path: path.join(dir, 'x.png'), seed: 1, style: 'anime', checkpoint: 'm', width: 1, height: 1, ms: 1 }) };
    const tool = new GenerateImageTool(generator as never, dir, { sheets, references: finder as never });
    await assert.rejects(tool.execute({ personagem: 'Nie Li (Tales of Demons and Gods)', descricao: 'x' }), /tem 2 fases salvas: .*Pergunte ao usuário qual fase usar/);
    await ResponseAttachments.collect(() => tool.execute({ personagem: 'Nie Li (Tales of Demons and Gods)', fase: 'adulto', descricao: 'walking' }));
    assert.match(generated[0]!.description, /^solo, Nie Li, adult man, walking$/);
    assert.equal(calls.length, 0, 'fase salva: não busca na internet');
    await ResponseAttachments.collect(() => tool.execute({ personagem: 'Nie Li (Tales of Demons and Gods)', fase: 'velho', descricao: 'sitting' }));
    assert.deepEqual(calls, ['Nie Li (Tales of Demons and Gods)|velho']);
    assert.ok(sheets.get('nie-li-velho'), 'a fase nova vira ficha');
  });
});

describe('Fichas de personagem e inspeção', () => {
  it('workflow com ficha: IP-Adapter (corpo + rosto) encadeado antes do sampler, lote e miniaturas para a inspeção', () => {
    const workflow = generationWorkflow({
      checkpoint: 'm',
      positive: 'p',
      negative: 'n',
      width: 832,
      height: 1216,
      seed: 1,
      steps: 6,
      cfg: 2,
      sampler: 'dpmpp_sde',
      scheduler: 'karras',
      clipSkip: 1,
      batch: 3,
      preview: true,
      references: [{ images: ['nie-li-ref-1.png', 'nie-li-ref-2.png'], weight: 0.6, faceWeight: 0.36 }],
    });
    assert.equal(workflow['5']!.inputs.batch_size, 3);
    assert.deepEqual(workflow['100'], { class_type: 'LoadImage', inputs: { image: 'nie-li-ref-1.png' } });
    assert.deepEqual(workflow['151'], { class_type: 'ImageBatch', inputs: { image1: ['100', 0], image2: ['101', 0] } }, 'as imagens da fase viram um lote');
    assert.deepEqual([workflow['50']!.inputs.model, workflow['50']!.inputs.ipadapter, workflow['50']!.inputs.image, workflow['50']!.inputs.weight, workflow['50']!.inputs.combine_embeds], [['4', 0], ['31', 0], ['151', 0], 0.6, 'average']);
    assert.deepEqual([workflow['60']!.inputs.model, workflow['60']!.inputs.ipadapter], [['50', 0], ['32', 0]], 'rosto encadeado depois do corpo');
    assert.deepEqual(workflow['3']!.inputs.model, ['60', 0], 'o sampler usa o modelo condicionado');
    assert.equal(workflow['21']!.class_type, 'SaveImage');
  });

  it('inspeção: anatomia vem antes da semelhança; erro de corpo em todas → nova rodada; persiste → avisa', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let prompts = 0;
    const comfy = {
      checkpoints: async () => ['animagine-xl-4.0-opt.safetensors'],
      hasNode: async () => true,
      uploadImage: async (_d: Buffer, name: string) => name,
      runOutputs: async () => (prompts++, { '9': [png, png, png], '21': [png, png, png] }),
    } as unknown as ComfyUIClient;
    const verdicts = [
      '{"candidatas": [{"anatomia_ok": false, "semelhanca": 9, "problema": "duas mãos direitas"}, {"anatomia_ok": true, "semelhanca": 6}, {"anatomia_ok": false, "semelhanca": 8}], "melhor": 1}',
    ];
    const judge = new ImageJudge(new FakeLlmProvider(verdicts.map((content) => ({ content }))));
    const gen = new ImageGenerator({ comfy, outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'insp-')), models: {}, defaultStyle: 'anime', quality: 'rapido', timeoutMs: 1000, idleUnloadMs: 0, judge });
    const ok = await gen.generate({ description: 'boy running', style: 'anime', candidates: 3, references: [{ images: [{ data: png, name: 'r.png', mime: 'image/png' }] }], character: 'Nie Li' });
    assert.deepEqual(ok.inspection, { versions: 3, rounds: 1, chosen: 2, anatomyOk: true, likeness: 6 }, 'prefere a de corpo certo mesmo com semelhança menor');
    assert.equal(ok.references, 1);

    const bad = '{"candidatas": [{"anatomia_ok": false, "semelhanca": 9, "problema": "braço a mais"}, {"anatomia_ok": false, "semelhanca": 5}, {"anatomia_ok": false, "semelhanca": 4}]}';
    const strict = new ImageGenerator({ comfy, outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'insp-')), models: {}, defaultStyle: 'anime', quality: 'rapido', timeoutMs: 1000, idleUnloadMs: 0, judge: new ImageJudge(new FakeLlmProvider([{ content: bad }, { content: bad }])) });
    prompts = 0;
    const failed = await strict.generate({ description: 'boy running', style: 'anime', candidates: 3 });
    assert.equal(prompts, 2, 'tentou uma segunda rodada');
    assert.deepEqual([failed.inspection?.rounds, failed.inspection?.anatomyOk], [2, false]);
    assert.match(failed.warning!, /possível erro no corpo \(braço a mais\)/);
  });
});
