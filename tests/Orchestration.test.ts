import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { OrchestratorConfig } from '../src/config/Config.js';
import { AllProvidersFailedError, LlmProviderError } from '../src/errors/AppErrors.js';
import { CostGuard } from '../src/llm/orchestration/CostGuard.js';
import { ModelCatalog } from '../src/llm/orchestration/ModelCatalog.js';
import { ModelRanker } from '../src/llm/orchestration/ModelRanker.js';
import { OrchestratedLlmProvider } from '../src/llm/orchestration/OrchestratedLlmProvider.js';
import { ScoreStore } from '../src/llm/orchestration/ScoreStore.js';
import { TaskClassifier } from '../src/llm/orchestration/TaskClassifier.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import type { ModelCandidate } from '../src/llm/orchestration/types.js';
import type { ILlmProvider, LlmRequest } from '../src/llm/types.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { SkillRouter } from '../src/skills/SkillRouter.js';

const CATALOG = {
  opencode: {
    api: 'https://opencode.ai/zen/v1',
    models: {
      'kimi-k2.5-free': { id: 'kimi-k2.5-free', tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 200000 } },
      'claude-paid': { id: 'claude-paid', tool_call: true, cost: { input: 3, output: 15 } },
      // Custo zero no catálogo, mas sem o sufixo '-free': não é um modelo gratuito do Zen.
      'gpt-zero-cost': { id: 'gpt-zero-cost', tool_call: true, cost: { input: 0, output: 0 } },
    },
  },
  openrouter: {
    models: {
      'meta/llama-4:free': { id: 'meta/llama-4:free', tool_call: true, cost: { input: 0, output: 0 } },
      'meta/llama-4': { id: 'meta/llama-4', tool_call: true, cost: { input: 1, output: 1 } },
    },
  },
  google: {
    models: {
      'gemini-3.8-flash': { id: 'gemini-3.8-flash', tool_call: true, modalities: { input: ['text', 'image'] }, cost: { input: 0.75, output: 3.75 } },
      'gemini-3.8-pro': { id: 'gemini-3.8-pro', tool_call: true, cost: { input: 5, output: 20 } },
    },
  },
  'alibaba-coding-plan': { models: { x: { id: 'x', tool_call: true, cost: { input: 0, output: 0 } } } },
};

const OLLAMA_TAGS = {
  models: [
    { name: 'qwen2.5:7b-instruct', size: 4.7e9, details: { parameter_size: '7.6B' } },
    { name: 'kimi-k2.6:cloud', size: 0, remote_model: 'kimi-k2.6', details: { parameter_size: '1T' } },
    { name: 'gigante:70b', size: 40e9, details: { parameter_size: '70B' } },
    { name: 'nomic-embed-text:latest', size: 0.3e9, details: { parameter_size: '137M' } },
  ],
};
const OLLAMA_SHOW: Record<string, string[]> = {
  'qwen2.5:7b-instruct': ['completion', 'tools'],
  'kimi-k2.6:cloud': ['completion', 'tools', 'vision'],
  'gigante:70b': ['completion', 'tools'],
  'nomic-embed-text:latest': ['embedding'],
};

function config(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  const cachePath = path.join(dir, 'models-dev.json');
  fs.writeFileSync(cachePath, JSON.stringify(CATALOG));
  return {
    enabled: true,
    costPolicy: 'free-only',
    freeSources: ['opencode', 'openrouter', 'nvidia', 'gemini', 'groq', 'ollama', 'ollama-cloud'],
    opencode: { enabled: true, apiKey: 'oc-key', baseUrl: undefined },
    openrouterApiKey: 'or-key',
    nvidiaApiKey: undefined,
    geminiFreeModels: ['gemini-3.8-flash'],
    groqFreeModels: ['llama-3.3-70b-versatile'],
    catalogUrl: 'http://catalog.invalid/api.json',
    catalogRefreshHours: 24,
    catalogCachePath: cachePath,
    privacyDefault: 'publico',
    sourcesTrainingOnData: ['opencode', 'openrouter', 'nvidia', 'gemini', 'ollama-cloud'],
    maxAttempts: 4,
    ...overrides,
  };
}

const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify(OLLAMA_TAGS));
  if (url.endsWith('/api/show')) {
    const name = (JSON.parse(String(init?.body)) as { model: string }).model;
    return new Response(JSON.stringify({ capabilities: OLLAMA_SHOW[name] ?? [], model_info: { 'x.context_length': 32768 } }));
  }
  throw new Error(`rede bloqueada no teste: ${url}`);
}) as typeof fetch;

/** VRAM de 12 GB: o modelo de 70B (40 GB) não cabe. */
const fakeRunner = { run: async () => ({ code: 0, stdout: '12288\n', stderr: '' }) } as never;

async function setup(overrides: Partial<OrchestratorConfig> = {}) {
  const cfg = config(overrides);
  const catalog = new ModelCatalog(cfg, 'http://localhost:11434/v1', fakeRunner, fakeFetch);
  await catalog.refresh({ gemini: 'g-key' });
  const scores = new ScoreStore(DatabaseConnection.open(':memory:'));
  const ranker = new ModelRanker(catalog, scores, new CostGuard(new Set(cfg.freeSources)));
  return { cfg, catalog, scores, ranker };
}

const ids = (list: Array<{ source: string; modelId: string }>) => list.map((c) => `${c.source}/${c.modelId}`).sort();

describe('ModelCatalog: só modelos realmente gratuitos', () => {
  it('aplica a regra de cada fonte e ignora assinaturas com "custo zero"', async () => {
    const { catalog } = await setup();
    assert.deepEqual(ids(catalog.list()), [
      'gemini/gemini-3.8-flash',
      'ollama-cloud/kimi-k2.6:cloud',
      'ollama/gigante:70b',
      'ollama/qwen2.5:7b-instruct',
      'opencode/kimi-k2.5-free',
      'openrouter/meta/llama-4:free',
    ]);
  });

  it('OPENCODE_ENABLED=false desliga o Zen; fonte sem chave fica de fora', async () => {
    const { catalog } = await setup({ opencode: { enabled: false, apiKey: 'oc-key', baseUrl: undefined }, openrouterApiKey: undefined });
    assert.ok(!catalog.list().some((c) => c.source === 'opencode' || c.source === 'openrouter'));
    const status = Object.fromEntries(catalog.sourceStatuses.map((s) => [s.source, s.reason]));
    assert.match(status.opencode!, /OPENCODE_ENABLED=false/);
    assert.match(status.openrouter!, /sem chave/);
  });

  it('separa modelos da GPU local dos ":cloud" e marca quem não cabe na VRAM', async () => {
    const { catalog } = await setup();
    const byId = Object.fromEntries(catalog.list().map((c) => [c.modelId, c]));
    assert.equal(byId['qwen2.5:7b-instruct']!.local, true);
    assert.equal(byId['qwen2.5:7b-instruct']!.gpuFit, true);
    assert.equal(byId['gigante:70b']!.gpuFit, false);
    assert.equal(byId['kimi-k2.6:cloud']!.local, false);
    assert.equal(byId['kimi-k2.6:cloud']!.source, 'ollama-cloud');
    assert.ok(!byId['nomic-embed-text:latest'], 'modelos só de embedding ficam fora');
  });

  it('parseParams entende B, T e M', () => {
    assert.equal(ModelCatalog.parseParams('7.6B'), 7.6);
    assert.equal(ModelCatalog.parseParams('1T'), 1000);
    assert.ok(Math.abs(ModelCatalog.parseParams('466.65M')! - 0.467) < 0.01);
  });
});

describe('CostGuard', () => {
  it('bloqueia fonte fora da lista e planos de assinatura', () => {
    const guard = new CostGuard(new Set(['opencode']));
    const base: ModelCandidate = { source: 'opencode', modelId: 'm', name: 'm', local: false, toolCall: true, vision: false, context: 0, trainsOnData: true, freeRule: 'regra' };
    assert.doesNotThrow(() => guard.assertFree(base));
    assert.throws(() => guard.assertFree({ ...base, source: 'groq' }), /FREE_SOURCES/);
    assert.throws(() => guard.assertFree({ ...base, freeRule: '' }), /sem regra de gratuidade/);
  });
});

describe('ModelRanker', () => {
  it('privacidade: "pessoal" exclui quem treina com dados; "local" só a GPU', async () => {
    const { ranker } = await setup();
    const req = { tools: true, vision: false, minContext: 1000 };
    const pessoal = ranker.rank('conversa', 'pessoal', req).map((r) => r.candidate);
    assert.ok(pessoal.every((c) => !c.trainsOnData));
    assert.ok(ranker.rank('conversa', 'local', req).every((r) => r.candidate.local));
  });

  it('visão exige modelo com imagem', async () => {
    const { ranker } = await setup();
    const visao = ranker.rank('visao', 'publico', { tools: false, vision: true, minContext: 0 });
    assert.ok(visao.length > 0 && visao.every((r) => r.candidate.vision));
  });

  it('GPU só vence se for tão boa quanto a nuvem: medição decide, empate favorece o local', async () => {
    const { ranker, scores } = await setup();
    const req = { tools: true, vision: false, minContext: 1000 };
    // Sem medição: o 7B local fica abaixo dos gratuitos grandes da nuvem.
    const before = ranker.rank('conversa', 'publico', req).map((r) => r.candidate.modelId);
    assert.ok(before.indexOf('qwen2.5:7b-instruct') > before.indexOf('kimi-k2.5-free'));
    // Medido: o local acerta tanto quanto o melhor da nuvem → vence pelo desempate (privado, sem cota).
    for (const r of ranker.rank('conversa', 'publico', req)) scores.recordEval('conversa', `${r.candidate.source}/${r.candidate.modelId}`, 0.6, 8);
    scores.recordEval('conversa', 'ollama/qwen2.5:7b-instruct', 0.9, 8);
    scores.recordEval('conversa', 'opencode/kimi-k2.5-free', 0.9, 8);
    const after = ranker.rank('conversa', 'publico', req);
    assert.equal(after[0]!.candidate.modelId, 'qwen2.5:7b-instruct');
  });

  it('modelo que não cabe na VRAM é penalizado; feedback negativo rebaixa', async () => {
    const { scores } = await setup();
    const local = (paramsB: number, gpuFit: boolean): ModelCandidate => ({ source: 'ollama', modelId: `m${paramsB}`, name: '', local: true, toolCall: true, vision: false, context: 0, trainsOnData: false, paramsB, gpuFit, freeRule: 'x' });
    assert.ok(ModelRanker.prior(local(70, false), 'conversa') < ModelRanker.prior(local(70, true), 'conversa'));
    assert.equal(scores.recordFeedback('conversa', 'ollama/m7', -1), -1);
  });
});

describe('TaskClassifier e SkillRouter.parseTask', () => {
  it('heurística e parse da tarefa devolvida pelo router', () => {
    assert.equal(TaskClassifier.heuristic('tenho um bug nessa função typescript'), 'codigo');
    assert.equal(TaskClassifier.heuristic('resuma esse texto'), 'resumo');
    assert.equal(TaskClassifier.heuristic('quem ganhou o jogo ontem?'), 'pesquisa');
    assert.equal(TaskClassifier.heuristic('oi, tudo bem?'), 'conversa');
    assert.equal(SkillRouter.parseTask('{"skillName": null, "task": "Raciocínio"}'), 'raciocinio');
    assert.equal(SkillRouter.parseTask('{"skillName": null}'), null);
    assert.equal(SkillRouter.parseTask('{"task": "dançar"}'), null);
  });
});

describe('OrchestratedLlmProvider', () => {
  function fakeProvider(key: string, behavior: (call: number) => Error | string, log: string[]): ILlmProvider {
    let calls = 0;
    return {
      name: key,
      model: key,
      healthCheck: async () => undefined,
      chat: async (_req: LlmRequest) => {
        log.push(key);
        const result = behavior(++calls);
        if (result instanceof Error) throw result;
        return { content: result, toolCalls: [], providerName: key, model: key };
      },
    };
  }

  async function orchestrator(behaviors: Record<string, (call: number) => Error | string>) {
    const { catalog, ranker, scores } = await setup();
    const log: string[] = [];
    const provider = new OrchestratedLlmProvider({
      catalog,
      ranker,
      scores,
      maxAttempts: 4,
      privacyDefault: 'publico',
      timeoutMs: 1000,
      ollamaTimeoutMs: 1000,
      temperature: 0,
      keys: { gemini: 'g-key' },
      createProvider: (c) => fakeProvider(`${c.source}/${c.modelId}`, behaviors[`${c.source}/${c.modelId}`] ?? (() => 'ok'), log),
    });
    return { provider, log, ranker, scores };
  }

  const request: LlmRequest = { messages: [{ role: 'user', content: 'oi' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] };

  it('cota esgotada (429) → cooldown e segue para o próximo; registra a decisão', async () => {
    const { provider, log, ranker } = await setup().then(async () => orchestrator({}));
    const first = ranker.rank('conversa', 'publico', { tools: true, vision: false, minContext: 0 })[0]!;
    const firstKey = `${first.candidate.source}/${first.candidate.modelId}`;
    const o = await orchestrator({ [firstKey]: () => new LlmProviderError('x', 'HTTP 429: quota exceeded', 429) });
    const response = await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: 'u1' }, () => o.provider.chat(request));
    assert.notEqual(response.providerName, firstKey);
    assert.equal(o.log[0], firstKey);
    assert.ok(o.scores.cooldown(firstKey), 'o modelo sem cota entra em cooldown');
    assert.equal(o.provider.lastDecision('u1')!.model, response.providerName);
    void provider;
    void log;
  });

  it('dentro de um ciclo do agente o modelo fica fixo (continuidade das tool calls)', async () => {
    const o = await orchestrator({});
    const ctx = { task: 'conversa' as const, privacy: 'publico' as const, userId: 'u2' };
    const a = await TaskContext.run(ctx, () => o.provider.chat(request));
    const b = await TaskContext.run(ctx, () => o.provider.chat(request));
    assert.equal(a.providerName, b.providerName);
  });

  it('todas as opções falhando → erro amigável', async () => {
    const o = await orchestrator(new Proxy({}, { get: () => () => new LlmProviderError('x', 'HTTP 500', 500) }) as never);
    await assert.rejects(TaskContext.run({ task: 'conversa', privacy: 'local', userId: 'u3' }, () => o.provider.chat(request)), AllProvidersFailedError);
  });

  it('documento (privacidade pessoal) nunca vai para fonte que treina com dados', async () => {
    const o = await orchestrator({});
    const response = await TaskContext.run({ task: 'resumo', privacy: 'pessoal', userId: 'u4' }, () => o.provider.chat(request));
    assert.match(response.providerName, /^ollama\//);
  });
});

describe('OrchestratedLlmProvider: fonte suspensa no meio da chamada', () => {
  it('chave recusada (401) suspende a fonte e as tentativas seguintes pulam os outros modelos dela', async () => {
    const { catalog, ranker, scores } = await setup();
    const log: string[] = [];
    const provider = new OrchestratedLlmProvider({
      catalog, ranker, scores, maxAttempts: 2, privacyDefault: 'publico', timeoutMs: 1000, ollamaTimeoutMs: 1000, temperature: 0, keys: { gemini: 'g' },
      createProvider: (c) => ({
        name: c.source, model: c.modelId, healthCheck: async () => undefined,
        chat: async () => {
          log.push(`${c.source}/${c.modelId}`);
          if (c.source === 'ollama-cloud' || c.source === 'opencode') throw new LlmProviderError(c.source, 'HTTP 401: Unauthorized', 401);
          return { content: 'ok', toolCalls: [], providerName: c.source, model: c.modelId };
        },
      }),
    });
    const response = await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: 'u' }, () =>
      provider.chat({ messages: [{ role: 'user', content: 'oi' }] }),
    );
    assert.ok(!/^(ollama-cloud|opencode)\//.test(response.providerName), 'resposta veio de uma fonte que funciona');
    assert.ok(log.filter((k) => k.startsWith('ollama-cloud/')).length <= 1, 'só um modelo da fonte suspensa foi tentado');
  });
});
