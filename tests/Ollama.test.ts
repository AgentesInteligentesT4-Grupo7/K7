import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Config } from '../src/config/Config.js';
import { LlmProviderError } from '../src/errors/AppErrors.js';
import { ProviderFactory } from '../src/llm/ProviderFactory.js';
import { GeminiProvider } from '../src/llm/providers/GeminiProvider.js';
import { OllamaProvider } from '../src/llm/providers/OllamaProvider.js';

const realFetch = globalThis.fetch;
const tools = [{ name: 'eco', description: 'x', parameters: { type: 'object' as const, properties: {} } }];

type Handler = (url: string, body: Record<string, unknown> | undefined) => Response;

function stubFetch(handler: Handler): Array<{ url: string; body: Record<string, unknown> | undefined }> {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    return handler(url, body);
  }) as typeof fetch;
  return calls;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const completion = (content: string) => json({ choices: [{ message: { content } }] });

const newProvider = () =>
  new OllamaProvider({ apiKey: 'ollama', model: 'qwen2.5:7b-instruct', timeoutMs: 5000, temperature: 0, retryDelaysMs: [0, 0] });

describe('OllamaProvider', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('usa o endpoint local compatível com OpenAI', async () => {
    const calls = stubFetch(() => completion('oi'));
    const response = await newProvider().chat({ messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(response.content, 'oi');
    assert.equal(response.providerName, 'ollama');
    assert.equal(calls[0]!.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(calls[0]!.body!.model, 'qwen2.5:7b-instruct');
    // Sempre limita a geração e desliga o raciocínio estendido por padrão.
    assert.equal(calls[0]!.body!.max_tokens, 4096);
    assert.equal(calls[0]!.body!.reasoning_effort, 'none');
  });

  it('repete sem tools quando o modelo não suporta tool calling e lembra disso', async () => {
    const calls = stubFetch((_url, body) =>
      body?.tools ? json({ error: { message: 'model does not support tools' } }, 400) : completion('sem tools'),
    );
    const provider = newProvider();
    const first = await provider.chat({ messages: [{ role: 'user', content: 'oi' }], tools });
    assert.equal(first.content, 'sem tools');
    await provider.chat({ messages: [{ role: 'user', content: 'de novo' }], tools });
    assert.deepEqual(
      calls.map((call) => Boolean(call.body?.tools)),
      [true, false, false],
    );
  });

  it('remove blocos <think> de modelos de raciocínio', async () => {
    stubFetch(() => completion('<think>pensando muito...</think>\n\nResposta final'));
    const response = await newProvider().chat({ messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(response.content, 'Resposta final');
  });

  it('healthCheck acusa modelo não baixado com a dica do ollama pull', async () => {
    stubFetch(() => json({ data: [{ id: 'llama3.1:8b' }] }));
    await assert.rejects(newProvider().healthCheck(), /ollama pull qwen2\.5:7b-instruct/);
  });

  it('healthCheck aceita o modelo com sufixo :latest', async () => {
    stubFetch(() => json({ data: [{ id: 'meu-modelo:latest' }] }));
    const provider = new OllamaProvider({ apiKey: 'ollama', model: 'meu-modelo', timeoutMs: 5000, temperature: 0 });
    await provider.healthCheck();
  });

  it('servidor fora do ar gera erro com dica de "ollama serve"', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(newProvider().chat({ messages: [] }), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.match(error.message, /ollama serve/);
      return true;
    });
  });
});

describe('Config + ProviderFactory com Ollama', () => {
  const base = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1' };

  it('LLM_PROVIDER=ollama não exige API key e respeita URL/modelo/timeout', () => {
    const config = new Config({
      ...base,
      LLM_PROVIDER: 'ollama',
      OLLAMA_MODEL: 'qwen3:8b',
      OLLAMA_BASE_URL: 'http://192.168.0.10:11434/v1/',
      OLLAMA_TIMEOUT_MS: '600000',
    });
    assert.equal(config.llmProvider, 'ollama');
    assert.equal(config.providers.ollama.baseUrl, 'http://192.168.0.10:11434/v1');
    const llm = new ProviderFactory(config).createWithFallback();
    assert.deepEqual(llm.providerNames, ['ollama']);
    assert.equal(llm.model, 'qwen3:8b');
  });

  it('Ollama pode ser fallback de um provider de nuvem', () => {
    const config = new Config({ ...base, GEMINI_API_KEY: 'k', LLM_FALLBACK_PROVIDERS: 'ollama' });
    assert.deepEqual(new ProviderFactory(config).createWithFallback().providerNames, ['gemini', 'ollama']);
  });
});

describe('GeminiProvider reasoning_effort', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('padrão "low" do Config chega ao corpo da requisição; vazio usa o padrão do Google', async () => {
    const base = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k' };
    const calls = stubFetch(() => completion('ok'));
    await new ProviderFactory(new Config(base)).create('gemini')!.chat({ messages: [] });
    await new ProviderFactory(new Config({ ...base, GEMINI_REASONING_EFFORT: '' })).create('gemini')!.chat({ messages: [] });
    assert.equal(calls[0]!.body!.reasoning_effort, 'low');
    assert.equal('reasoning_effort' in calls[1]!.body!, false);
    assert.equal(calls[0]!.body!.model, 'gemini-3.8-flash');
  });
});

describe('Novas tentativas em falhas temporárias (ex.: Gemini 503 "high demand")', () => {
  const gemini = () => new GeminiProvider({ apiKey: 'k', model: 'gemini-3.8-flash', timeoutMs: 5000, temperature: 0, retryDelaysMs: [0, 0] });
  const busy = () => json({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }, 503);

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('503 seguido de sucesso: repete e devolve a resposta', async () => {
    let n = 0;
    const calls = stubFetch(() => (++n < 3 ? busy() : completion('voltou')));
    const response = await gemini().chat({ messages: [{ role: 'user', content: 'oi' }] });
    assert.equal(response.content, 'voltou');
    assert.equal(calls.length, 3);
  });

  it('503 persistente: desiste após as tentativas (o fallback assume)', async () => {
    const calls = stubFetch(busy);
    await assert.rejects(gemini().chat({ messages: [] }), (error: unknown) => {
      assert.ok(error instanceof LlmProviderError);
      assert.equal(error.status, 503);
      return true;
    });
    assert.equal(calls.length, 3);
  });

  it('erros definitivos (400) não são repetidos', async () => {
    const calls = stubFetch(() => json({ error: { message: 'bad request' } }, 400));
    await assert.rejects(gemini().chat({ messages: [] }), LlmProviderError);
    assert.equal(calls.length, 1);
  });
});

describe('Timeout próprio do Gemini', () => {
  it('padrão de 60s (independente do LLM_TIMEOUT_MS) e configurável', () => {
    const base = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k', LLM_TIMEOUT_MS: '120000' };
    assert.equal(new Config(base).providers.gemini.timeoutMs, 60_000);
    assert.equal(new Config({ ...base, GEMINI_TIMEOUT_MS: '90000' }).providers.gemini.timeoutMs, 90_000);
  });
});
