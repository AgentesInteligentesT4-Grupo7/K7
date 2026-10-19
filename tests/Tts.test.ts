import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Config, ConfigError } from '../src/config/Config.js';
import { AudioSynthesisError } from '../src/errors/AppErrors.js';
import { KokoroTtsSynthesizer } from '../src/telegram/output/tts/KokoroTtsSynthesizer.js';
import { FallbackTextToSpeech, type ITextToSpeech } from '../src/telegram/output/tts/TextToSpeech.js';

const realFetch = globalThis.fetch;
const kokoro = () =>
  new KokoroTtsSynthesizer({ baseUrl: 'http://localhost:8880/v1', voice: 'pf_dora', speed: 1, langCode: 'p', timeoutMs: 2000 });

describe('KokoroTtsSynthesizer', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('pede OGG/Opus em pt-BR e detecta o formato pelo cabeçalho', async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(Buffer.from('OggS....audio'), { status: 200 });
    }) as typeof fetch;
    const result = await kokoro().synthesize('Olá');
    assert.equal(result.format, 'ogg');
    assert.deepEqual(
      { voice: body.voice, response_format: body.response_format, lang_code: body.lang_code, input: body.input },
      { voice: 'pf_dora', response_format: 'opus', lang_code: 'p', input: 'Olá' },
    );
  });

  it('servidor fora do ar vira AudioSynthesisError com dica do container', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(kokoro().synthesize('Olá'), (error: unknown) => {
      assert.ok(error instanceof AudioSynthesisError);
      assert.match(error.message, /container/);
      return true;
    });
  });

  it('healthCheck acusa voz inexistente listando as vozes pt-BR', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ voices: [{ id: 'af_heart' }, { id: 'pm_alex' }] }), { status: 200 })) as typeof fetch;
    await assert.rejects(kokoro().healthCheck(), /pm_alex/);
  });
});

describe('FallbackTextToSpeech', () => {
  const engine = (name: string, fail: boolean): ITextToSpeech => ({
    name,
    voice: `${name}-voz`,
    synthesize: async () => {
      if (fail) throw new Error(`${name} caiu`);
      return { audio: Buffer.from('x'), format: 'mp3' };
    },
  });

  it('usa o próximo motor quando o primeiro falha', async () => {
    const tts = new FallbackTextToSpeech([engine('kokoro', true), engine('edge', false)]);
    assert.equal((await tts.synthesize('oi')).format, 'mp3');
    assert.equal(tts.voice, 'kokoro-voz');
  });

  it('todos falhando gera AudioSynthesisError (handler cai para texto)', async () => {
    const tts = new FallbackTextToSpeech([engine('kokoro', true), engine('edge', true)]);
    await assert.rejects(tts.synthesize('oi'), AudioSynthesisError);
  });
});

describe('Config de TTS', () => {
  const base = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k' };

  it('Kokoro é o padrão, com voz pf_dora', () => {
    const config = new Config(base);
    assert.deepEqual(config.ttsEngines, ['kokoro']);
    assert.equal(config.kokoro.voice, 'pf_dora');
    assert.equal(config.kokoro.baseUrl, 'http://localhost:8880/v1');
  });

  it('aceita cadeia e rejeita motor desconhecido', () => {
    assert.deepEqual(new Config({ ...base, TTS_ENGINES: 'kokoro, edge' }).ttsEngines, ['kokoro', 'edge']);
    assert.throws(() => new Config({ ...base, TTS_ENGINES: 'piper' }), ConfigError);
  });
});
