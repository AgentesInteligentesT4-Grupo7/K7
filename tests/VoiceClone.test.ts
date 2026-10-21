import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { UserFacingError } from '../src/errors/AppErrors.js';
import { TelegramOutputHandler } from '../src/telegram/output/TelegramOutputHandler.js';
import type { ITextToSpeech } from '../src/telegram/output/tts/TextToSpeech.js';
import { VoiceCloneTagParser } from '../src/telegram/output/VoiceCloneTagParser.js';
import { AudioSampleConverter, UnsupportedAudioFormatError } from '../src/voice/AudioSampleConverter.js';
import { ChatterboxVoiceCloner } from '../src/voice/ChatterboxVoiceCloner.js';
import { VoiceLibrary, VoiceNotFoundError } from '../src/voice/VoiceLibrary.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'voz-amostra.ogg');
const converter = new AudioSampleConverter();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'));
const silenceWav = (seconds: number) => AudioSampleConverter.encodeWav([new Float32Array(48_000 * seconds)], 48_000);

describe('AudioSampleConverter', () => {
  it('converte voice note OGG/Opus do Telegram em WAV com a duração correta', async () => {
    const result = await converter.toReferenceAudio(fs.readFileSync(FIXTURE), '.ogg');
    assert.equal(result.extension, 'wav');
    assert.equal(result.buffer.toString('latin1', 0, 4), 'RIFF');
    assert.ok(Math.abs(result.durationSeconds! - 5.14) < 0.05);
    assert.ok(Math.abs(AudioSampleConverter.wavDuration(result.buffer)! - result.durationSeconds!) < 0.01);
  });

  it('detecta OGG pelo conteúdo mesmo com extensão errada, e rejeita formatos sem suporte', async () => {
    assert.equal((await converter.toReferenceAudio(fs.readFileSync(FIXTURE), '.bin')).extension, 'wav');
    await assert.rejects(converter.toReferenceAudio(Buffer.from('xx'), '.m4a'), UnsupportedAudioFormatError);
    assert.equal((await converter.toReferenceAudio(Buffer.from('ID3'), 'mp3')).extension, 'mp3');
  });
});

describe('VoiceLibrary', () => {
  it('salva o áudio do Telegram como <nome>.wav e o encontra pelo nome', async () => {
    const dir = tempDir();
    const library = new VoiceLibrary({ dir }, converter);
    const { sample, durationSeconds } = await library.save('Minha Voz', fs.readFileSync(FIXTURE), '.ogg');
    assert.equal(sample.name, 'minha-voz');
    assert.equal(path.basename(sample.filePath), 'minha-voz.wav');
    assert.ok(durationSeconds! > 5);
    assert.equal(library.resolve('MINHA VOZ').name, 'minha-voz');
    assert.equal(library.resolve().name, 'minha-voz'); // única voz → padrão implícito
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('arquivos colocados manualmente na pasta viram vozes (e .ogg é convertido no uso)', async () => {
    const dir = tempDir();
    fs.copyFileSync(FIXTURE, path.join(dir, 'agro.ogg'));
    fs.writeFileSync(path.join(dir, 'outra.wav'), silenceWav(6));
    fs.writeFileSync(path.join(dir, 'leia-me.txt'), 'ignorado');
    const library = new VoiceLibrary({ dir, defaultVoice: 'agro' }, converter);
    assert.deepEqual(library.list().map((v) => v.name), ['agro', 'outra']);
    const sample = library.resolve();
    assert.equal(sample.name, 'agro');
    assert.equal((await library.load(sample)).extension, 'wav');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('regravar a mesma voz substitui o arquivo anterior', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'minha-voz.mp3'), Buffer.from('ID3 antigo'));
    const library = new VoiceLibrary({ dir }, converter);
    await library.save('minha-voz', fs.readFileSync(FIXTURE), '.ogg');
    assert.deepEqual(fs.readdirSync(dir), ['minha-voz.wav']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('erros amigáveis: áudio curto, nenhuma voz, várias vozes sem padrão, voz inexistente', async () => {
    const dir = tempDir();
    const library = new VoiceLibrary({ dir }, converter);
    assert.throws(() => library.resolve(), VoiceNotFoundError);
    await assert.rejects(library.save('curta', silenceWav(1), '.wav'), (error: unknown) => {
      assert.ok(error instanceof UserFacingError);
      assert.match(error.userMessage, /muito curto/);
      return true;
    });
    fs.writeFileSync(path.join(dir, 'a.wav'), silenceWav(5));
    fs.writeFileSync(path.join(dir, 'b.wav'), silenceWav(5));
    assert.throws(() => library.resolve(), /VOICE_CLONE_DEFAULT/);
    assert.throws(() => library.resolve('zzz'), /não encontrada/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ChatterboxVoiceCloner', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('envia a amostra uma única vez (nome versionado por hash) e pede /tts em clone + pt + opus', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const remote: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body });
      if (url.endsWith('/get_reference_files')) return new Response(JSON.stringify(remote));
      if (url.endsWith('/upload_reference')) {
        remote.push(((init.body as FormData).get('files') as File).name);
        return new Response('{}');
      }
      return new Response(Buffer.from('OggS...voz'));
    }) as typeof fetch;

    const cloner = new ChatterboxVoiceCloner({ baseUrl: 'http://localhost:8004', language: 'pt', timeoutMs: 2000 });
    const reference = { buffer: silenceWav(6), extension: 'wav' as const, durationSeconds: 6 };
    const first = await cloner.synthesize('Olá', 'minha-voz', reference);
    await cloner.synthesize('De novo', 'minha-voz', reference);

    assert.equal(first.format, 'ogg');
    assert.equal(calls.filter((c) => c.url.endsWith('/upload_reference')).length, 1);
    assert.match(remote[0]!, /^minha-voz-[0-9a-f]{10}\.wav$/);
    const tts = JSON.parse(String(calls.find((c) => c.url.endsWith('/tts'))!.body));
    assert.deepEqual(
      { voice_mode: tts.voice_mode, language: tts.language, output_format: tts.output_format, ref: tts.reference_audio_filename },
      { voice_mode: 'clone', language: 'pt', output_format: 'opus', ref: remote[0] },
    );
  });
});

describe('Saída com voz clonada', () => {
  it('VoiceCloneTagParser separa os trechos falados do texto', () => {
    const parsed = VoiceCloneTagParser.parse('Aqui está 👇\n<voz_clonada voz="agro">Oi Maria, feliz aniversário!</voz_clonada>');
    assert.equal(parsed.text, 'Aqui está 👇');
    assert.deepEqual(parsed.segments, [{ voice: 'agro', text: 'Oi Maria, feliz aniversário!' }]);
    assert.deepEqual(VoiceCloneTagParser.parse('<voz_clonada>sem nome</voz_clonada>').segments, [{ voice: undefined, text: 'sem nome' }]);
  });

  function handler(resolve: (voice?: string) => ITextToSpeech) {
    const log: string[] = [];
    const output = new TelegramOutputHandler(
      {
        text: { send: async (_c, text) => void log.push(`text:${text}`) },
        file: { send: async () => undefined },
        error: { send: async () => undefined },
        audio: { send: async (_c, text, tts) => void log.push(`audio:${tts?.voice ?? 'padrão'}:${text}`) },
      },
      { asTextToSpeech: resolve },
    );
    return { log, output };
  }

  const fakeTts = (voice: string): ITextToSpeech => ({ name: 'voz-clonada', voice, synthesize: async () => ({ audio: Buffer.from(''), format: 'ogg' }) });

  it('resposta do LLM com a tag vira voice note com a voz pedida', async () => {
    const { log, output } = handler((voice) => fakeTts(voice ?? 'minha-voz'));
    await output.send(1, { text: 'Pronto!\n<voz_clonada voz="agro">Chego às oito.</voz_clonada>', isAudio: false });
    assert.deepEqual(log, ['text:Pronto!', 'audio:agro:Chego às oito.']);
  });

  it('/falar sem voz cadastrada responde com aviso amigável em vez de quebrar', async () => {
    const { log, output } = handler(() => {
      throw new VoiceNotFoundError('Nenhuma voz cadastrada ainda. Use /minhavoz.');
    });
    await output.sendClonedVoice(1, 'Oi');
    assert.equal(log.length, 1);
    assert.match(log[0]!, /^text:⚠️ Não consegui gerar com a voz clonada: Nenhuma voz cadastrada/);
  });
});
