import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Config } from '../src/config/Config.js';
import { TranscriptionFailedError, WhisperUnavailableError } from '../src/errors/AppErrors.js';
import { WhisperHttpTranscriber } from '../src/telegram/input/WhisperHttpTranscriber.js';

const realFetch = globalThis.fetch;
const audioFile = (): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stt-')), 'voice.ogg');
  fs.writeFileSync(file, Buffer.from('OggS fake audio'));
  return file;
};
const transcriber = () =>
  new WhisperHttpTranscriber({ baseUrl: 'http://localhost:8890/v1', model: 'turbo', language: 'pt', timeoutMs: 2000 });

describe('WhisperHttpTranscriber', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('envia multipart com arquivo, modelo e idioma e limpa marcadores de silêncio', async () => {
    let form: FormData | undefined;
    let url = '';
    globalThis.fetch = (async (input: string, init: RequestInit) => {
      url = input;
      form = init.body as FormData;
      return new Response(JSON.stringify({ text: ' Olá, tudo bem? [BLANK_AUDIO] ' }), { status: 200 });
    }) as typeof fetch;

    assert.equal(await transcriber().transcribe(audioFile()), 'Olá, tudo bem?');
    assert.equal(url, 'http://localhost:8890/v1/audio/transcriptions');
    assert.equal(form!.get('model'), 'turbo');
    assert.equal(form!.get('language'), 'pt');
    assert.equal((form!.get('file') as File).name, 'voice.ogg');
  });

  it('container fora do ar → WhisperUnavailableError; HTTP 500 → TranscriptionFailedError', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(transcriber().transcribe(audioFile()), WhisperUnavailableError);

    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await assert.rejects(transcriber().transcribe(audioFile()), TranscriptionFailedError);
  });

  it('Config aceita WHISPER_ENGINE=http com URL e modelo padrão', () => {
    const config = new Config({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k', WHISPER_ENGINE: 'http' });
    assert.equal(config.whisperEngine, 'http');
    assert.equal(config.whisperBaseUrl, 'http://localhost:8890/v1');
    assert.equal(config.whisperModel, 'deepdml/faster-whisper-large-v3-turbo-ct2');
  });
});
