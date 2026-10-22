import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import { chunkText } from '../src/modules/conhecimento/Chunker.js';
import { GeminiEmbeddings, type IEmbeddings, OllamaEmbeddings, selectEmbeddings } from '../src/modules/conhecimento/Embeddings.js';
import { KnowledgeIndexer } from '../src/modules/conhecimento/KnowledgeIndexer.js';
import { DEFAULT_RETRIEVAL, KnowledgeRetriever, formatRetrieval } from '../src/modules/conhecimento/KnowledgeRetriever.js';
import { KnowledgeStore, ftsQuery, reciprocalRankFusion } from '../src/modules/conhecimento/KnowledgeStore.js';
import { SaveKnowledgeTool, SearchKnowledgeTool } from '../src/modules/conhecimento/KnowledgeTools.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Embeddings determinísticos: saco de palavras em 64 dimensões (sinônimos mapeados para a mesma palavra). */
class FakeEmbeddings implements IEmbeddings {
  readonly name = 'fake';
  readonly model = 'fake-64';
  readonly batchSize = 2;
  readonly calls: string[][] = [];
  constructor(private readonly synonyms: Record<string, string> = {}) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map((t) => {
      const v = new Float32Array(64);
      for (const raw of plain(t).split(/[^a-z0-9]+/).filter((w) => w.length > 2)) {
        const word = this.synonyms[raw] ?? raw;
        let h = 0;
        for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 64;
        v[h]! += 1;
      }
      return v;
    });
  }
}

function setup(files: Record<string, string>, options: { embeddings?: IEmbeddings } = {}) {
  const fita = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fita-'));
  const usuario = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-user-'));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(fita, file)), { recursive: true });
    fs.writeFileSync(path.join(fita, file), content);
  }
  const store = new KnowledgeStore(DatabaseConnection.open(':memory:'));
  const embeddings = options.embeddings ? async () => options.embeddings : undefined;
  const indexer = new KnowledgeIndexer(store, [{ label: 'fita', dir: fita }, { label: 'usuario', dir: usuario }], { chunk: { size: 300, overlap: 40 }, rescanMs: 0, ...(embeddings ? { embeddings } : {}) });
  return { fita, usuario, store, indexer, embeddings };
}

const FILES = {
  'bases.yaml': 'loja:\n  descricao: "Políticas da loja"\n  idioma: pt-BR\nreceitas: "Receitas da família"\n',
  'loja/trocas.md': '# Trocas\n\nProdutos com defeito podem ser trocados em até 30 dias, com nota fiscal.\n\nTrocas por arrependimento valem por 7 dias em compras online.',
  'loja/entrega.txt': 'O frete é grátis acima de 200 reais para as capitais.',
  'receitas/bolo.md': '# Bolo de cenoura\n\nBata 3 cenouras, 3 ovos e 1 xícara de óleo. Asse por 40 minutos.',
  'leia-me.md': 'Arquivo solto na raiz vai para a base geral.',
  'ignorado.docx': 'binário',
};

describe('Base de conhecimento: fatiamento e índice', () => {
  it('fatia respeitando parágrafos, com sobreposição, e quebra parágrafo grande em frases', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Parágrafo ${i + 1}. ${'palavra '.repeat(20).trim()}.`);
    const chunks = chunkText(paragraphs.join('\n\n'), { size: 400, overlap: 60 });
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.length <= 400 + 60 + 2), 'trecho não passa muito do alvo');
    assert.ok(chunks[1]!.startsWith('palavra'), 'o próximo trecho repete o fim do anterior');
    const long = chunkText(`${'Frase curta aqui. '.repeat(60)}`, { size: 200, overlap: 0 });
    assert.ok(long.length > 3 && long.every((c) => c.length <= 200));
  });

  it('consulta FTS sem palavras vazias; RRF soma as listas', () => {
    assert.equal(ftsQuery('Qual é o prazo de troca do produto em SP?'), '"prazo"* OR "troca"* OR "produto"* OR "sp"');
    assert.equal(ftsQuery('a de o'), '');
    assert.deepEqual(reciprocalRankFusion([[1, 2, 3], [3, 1]]).map((r) => r.id), [1, 3, 2]);
  });

  it('indexa as pastas (bases por subpasta + bases.yaml), reindexa só o que mudou e remove apagados', async () => {
    const { fita, store, indexer } = setup(FILES);
    await indexer.sync(true);
    assert.deepEqual(store.documents().map((d) => [d.key, d.base]), [
      ['fita:leia-me.md', 'geral'],
      ['fita:loja/entrega.txt', 'loja'],
      ['fita:loja/trocas.md', 'loja'],
      ['fita:receitas/bolo.md', 'receitas'],
    ]);
    assert.deepEqual(indexer.bases().map((b) => [b.name, b.description, b.language ?? '', b.documents]), [
      ['geral', '', '', 1],
      ['loja', 'Políticas da loja', 'pt-BR', 2],
      ['receitas', 'Receitas da família', '', 1],
    ]);
    fs.writeFileSync(path.join(fita, 'receitas/bolo.md'), '# Bolo de fubá\n\nFubá, leite e ovos.');
    fs.rmSync(path.join(fita, 'leia-me.md'));
    await indexer.sync(true);
    assert.equal(store.documents().some((d) => d.key === 'fita:leia-me.md'), false);
    assert.equal(store.lexical('cenoura', undefined, 5).length, 0, 'texto antigo saiu do FTS');
    assert.equal(store.lexical('fuba', undefined, 5).length, 1, 'sem acento também acha');
  });
});

describe('Base de conhecimento: recuperação', () => {
  it('só palavras: acha o trecho certo e filtra por base; o texto sai numerado para citar', async () => {
    const { indexer, store } = setup(FILES);
    const retriever = new KnowledgeRetriever(store, indexer);
    const result = await retriever.retrieve('Qual o prazo para trocar produto com defeito?');
    assert.equal(result.usedVectors, false);
    assert.match(result.chunks[0]!.text, /defeito/);
    assert.equal((await retriever.retrieve('defeito', { bases: ['receitas'] })).chunks.length, 0);
    const text = formatRetrieval(result);
    assert.match(text, /^<conteudo_externo fonte="base de conhecimento">\n\[1\] loja\/trocas\.md \(base loja, trecho 1\)/);
    assert.match(text, /Cite os trechos como \[1\]/);
    assert.match(formatRetrieval({ route: 'simples', queries: [], chunks: [], usedVectors: false }), /Nada encontrado/);
  });

  it('com vetores: acha por sinônimo (sem palavra em comum) e gera os vetores em lotes', async () => {
    const embeddings = new FakeEmbeddings({ devolver: 'troca', devolucao: 'troca', trocados: 'troca', trocas: 'troca' });
    const { indexer, store } = setup(FILES, { embeddings });
    await indexer.sync(true);
    assert.deepEqual(store.stats().embedded, { 'fake-64': store.stats().chunks });
    assert.ok(embeddings.calls.every((batch) => batch.length <= 2), 'respeita o lote do provedor');
    const retriever = new KnowledgeRetriever(store, indexer, DEFAULT_RETRIEVAL, { embeddings: async () => embeddings });
    const result = await retriever.retrieve('devolver');
    assert.equal(result.usedVectors, true);
    assert.match(result.chunks[0]!.text, /trocados|Trocas/);
  });

  it('planejador (Adaptive + RAG-Fusion + HyDE) num pedido só; a hipótese vai para a busca vetorial', async () => {
    const embeddings = new FakeEmbeddings();
    const { indexer, store } = setup(FILES, { embeddings });
    const llm = new FakeLlmProvider([
      { content: '{"rota": "complexa", "variacoes": ["frete grátis", "custo de entrega"], "subperguntas": ["valor mínimo do frete grátis"], "hipotese": "O frete é grátis nas capitais."}' },
      { content: '{"rota": "direta"}' },
    ]);
    const retriever = new KnowledgeRetriever(store, indexer, { ...DEFAULT_RETRIEVAL, fusion: 2, hyde: true, adaptive: true }, { llm, embeddings: async () => embeddings });
    const result = await TaskContext.run({ task: 'conversa', privacy: 'pessoal', userId: '7' }, () => retriever.retrieve('Quanto custa a entrega?'));
    assert.equal(result.route, 'complexa');
    assert.deepEqual(result.queries, ['Quanto custa a entrega?', 'frete grátis', 'custo de entrega', 'valor mínimo do frete grátis']);
    assert.match(result.chunks[0]!.text, /frete é grátis/);
    assert.deepEqual(embeddings.calls.at(-1), [...result.queries, 'O frete é grátis nas capitais.']);
    const system = llm.requests[0]!.messages[0]!.content!;
    assert.match(system, /"rota"[\s\S]*"variacoes": 2 reformulações[\s\S]*"hipotese"/);
    const direct = await retriever.retrieve('oi, tudo bem?', { allowDirect: true });
    assert.deepEqual([direct.route, direct.chunks.length], ['direta', 0]);
  });

  it('CRAG: trechos fracos → internet; ambíguo → base + internet; correto → só a base', async () => {
    const { indexer, store } = setup(FILES);
    const searches: string[] = [];
    const webSearch = async (q: string) => (searches.push(q), 'resultado da internet');
    const run = async (grades: string) => {
      const llm = new FakeLlmProvider([{ content: grades }]);
      return new KnowledgeRetriever(store, indexer, { ...DEFAULT_RETRIEVAL, crag: true, results: 2 }, { llm, webSearch }).retrieve('troca de produto com defeito');
    };
    const wrong = await run('{"notas": [0.1, 0, 0, 0]}');
    assert.deepEqual([wrong.verdict, wrong.chunks.length, wrong.web], ['incorreto', 0, 'resultado da internet']);
    assert.match(formatRetrieval(wrong), /A base não tem trechos relevantes[\s\S]*use os resultados da internet/);
    const mixed = await run('{"notas": [0.5, 0.2, 0, 0]}');
    assert.deepEqual([mixed.verdict, mixed.chunks.length, Boolean(mixed.web)], ['ambiguo', 1, true]);
    const right = await run('{"notas": [0.9, 0.1, 0, 0]}');
    assert.deepEqual([right.verdict, right.chunks.length, right.web], ['correto', 1, undefined]);
    assert.equal(searches.length, 2);
  });
});

describe('Base de conhecimento: ferramentas e provedores', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const originalFetch = globalThis.fetch;

  it('consultar_conhecimento lista as bases na descrição e recusa base inexistente; guardar cria arquivo e indexa', async () => {
    const { indexer, store, usuario } = setup(FILES);
    await indexer.sync(true);
    const deps = { store, indexer, retriever: new KnowledgeRetriever(store, indexer), userDir: usuario };
    const search = new SearchKnowledgeTool(deps);
    assert.match(search.description, /Bases: geral; loja \(Políticas da loja\); receitas \(Receitas da família\)/);
    await assert.rejects(search.execute({ consulta: 'x', base: 'nada' }), /Base "nada" não existe/);
    const save = new SaveKnowledgeTool(deps);
    const saved = await save.execute({ titulo: 'Senha do Wi-Fi da casa', texto: 'A rede da sala se chama Varanda.' });
    assert.match(saved.output, /Guardado em anotacoes\/senha-do-wi-fi-da-casa\.md/);
    assert.ok(fs.existsSync(path.join(usuario, 'anotacoes', 'senha-do-wi-fi-da-casa.md')));
    assert.match((await search.execute({ consulta: 'rede varanda' })).output, /\[1\] anotacoes\/senha-do-wi-fi-da-casa\.md \(base anotacoes/);
  });

  it('auto: Ollama só com GPU e modelo baixado; senão Gemini; "off" desliga; nada é baixado', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ models: [{ name: 'embeddinggemma:latest' }] }));
    }) as typeof fetch;
    const ollama = new OllamaEmbeddings('http://ollama:11434', 'embeddinggemma');
    const gemini = new GeminiEmbeddings('chave', 'gemini-embedding-001');
    assert.equal(await selectEmbeddings({ choice: 'auto', ollama, gemini, hasGpu: async () => true }), ollama);
    assert.equal(await selectEmbeddings({ choice: 'auto', ollama, gemini, hasGpu: async () => false }), gemini);
    assert.equal(await selectEmbeddings({ choice: 'off', ollama, gemini, hasGpu: async () => true }), undefined);
    const missing = new OllamaEmbeddings('http://ollama:11434', 'bge-m3');
    assert.equal(await selectEmbeddings({ choice: 'auto', ollama: missing, gemini, hasGpu: async () => true }), gemini, 'modelo ausente cai para o Gemini');
    assert.ok(urls.every((u) => u.endsWith('/api/tags')), 'só consulta a lista de modelos');
  });

  it('Gemini: lote com taskType de consulta, 768 dimensões e chave no cabeçalho (não na URL)', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] }));
    }) as typeof fetch;
    const vectors = await new GeminiEmbeddings('segredo', 'gemini-embedding-001').embed(['a', 'b'], 'consulta');
    assert.equal(vectors.length, 2);
    assert.equal(request!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents');
    assert.equal((request!.init.headers as Record<string, string>)['x-goog-api-key'], 'segredo');
    const body = JSON.parse(String(request!.init.body)) as { requests: Array<{ taskType: string; outputDimensionality: number }> };
    assert.deepEqual([body.requests[0]!.taskType, body.requests[0]!.outputDimensionality], ['RETRIEVAL_QUERY', 768]);
  });
});
