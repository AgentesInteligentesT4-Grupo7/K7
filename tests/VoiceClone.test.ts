import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { UserFacingError } from '../src/errors/AppErrors.js';
import { TelegramOutputHandler } from '../src/canais/telegram/output/TelegramOutputHandler.js';
import type { ITextToSpeech } from '../src/voice/tts/TextToSpeech.js';
import { VoiceCloneTagParser } from '../src/canais/comum/VoiceCloneTagParser.js';
import { AudioSampleConverter, UnsupportedAudioFormatError } from '../src/voice/AudioSampleConverter.js';
import { ChatterboxVoiceCloner } from '../src/voice/ChatterboxVoiceCloner.js';
import { VoiceCloneService } from '../src/voice/VoiceCloneService.js';
import { VoiceLibrary, VoiceNotFoundError } from '../src/voice/VoiceLibrary.js';
import { silentOgg } from './helpers/syntheticOgg.js';

/** Voice note sintético (5,14 s de silêncio): o repositório não guarda amostras de voz. */
const VOICE_NOTE = silentOgg(5140);
const converter = new AudioSampleConverter();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voices-'));
const silenceWav = (seconds: number) => AudioSampleConverter.encodeWav([new Float32Array(48_000 * seconds)], 48_000);

describe('AudioSampleConverter', () => {
  it('converte voice note OGG/Opus do Telegram em WAV com a duração correta', async () => {
    const result = await converter.toReferenceAudio(VOICE_NOTE, '.ogg');
    assert.equal(result.extension, 'wav');
    assert.equal(result.buffer.toString('latin1', 0, 4), 'RIFF');
    assert.ok(Math.abs(result.durationSeconds! - 5.14) < 0.05);
    assert.ok(Math.abs(AudioSampleConverter.wavDuration(result.buffer)! - result.durationSeconds!) < 0.01);
  });

  it('detecta OGG pelo conteúdo mesmo com extensão errada, e rejeita formatos sem suporte', async () => {
    assert.equal((await converter.toReferenceAudio(VOICE_NOTE, '.bin')).extension, 'wav');
    await assert.rejects(converter.toReferenceAudio(Buffer.from('xx'), '.m4a'), UnsupportedAudioFormatError);
    assert.equal((await converter.toReferenceAudio(Buffer.from('ID3'), 'mp3')).extension, 'mp3');
  });
});

describe('VoiceLibrary', () => {
  it('salva o áudio do Telegram como <nome>.wav e o encontra pelo nome', async () => {
    const dir = tempDir();
    const library = new VoiceLibrary({ dir }, converter);
    const { sample, durationSeconds } = await library.save('Minha Voz', VOICE_NOTE, '.ogg');
    assert.equal(sample.name, 'minha-voz');
    assert.equal(path.basename(sample.filePath), 'minha-voz.wav');
    assert.ok(durationSeconds! > 5);
    assert.equal(library.resolve('MINHA VOZ').name, 'minha-voz');
    assert.equal(library.resolve().name, 'minha-voz'); // única voz → padrão implícito
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('arquivos colocados manualmente na pasta viram vozes (e .ogg é convertido no uso)', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'parreira.ogg'), VOICE_NOTE);
    fs.writeFileSync(path.join(dir, 'outra.wav'), silenceWav(6));
    fs.writeFileSync(path.join(dir, 'leia-me.txt'), 'ignorado');
    const library = new VoiceLibrary({ dir, defaultVoice: 'parreira' }, converter);
    assert.deepEqual(library.list().map((v) => v.name), ['outra', 'parreira']);
    const sample = library.resolve();
    assert.equal(sample.name, 'parreira');
    assert.equal((await library.load(sample)).extension, 'wav');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('regravar a mesma voz substitui o arquivo anterior', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'minha-voz.mp3'), Buffer.from('ID3 antigo'));
    const library = new VoiceLibrary({ dir }, converter);
    await library.save('minha-voz', VOICE_NOTE, '.ogg');
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

  it('voz padrão apagada: com uma voz só, usa ela; com várias, explica e mostra como escolher', async () => {
    const dir = tempDir();
    const library = new VoiceLibrary({ dir, defaultVoice: 'minha-voz' }, converter);
    fs.writeFileSync(path.join(dir, 'mulher.wav'), silenceWav(5));
    assert.equal(library.resolve().name, 'mulher');
    assert.throws(() => library.resolve('minha-voz'), /Voz "minha-voz" não encontrada/, 'pedida pelo nome continua sendo erro');
    fs.writeFileSync(path.join(dir, 'galvao.wav'), silenceWav(5));
    assert.throws(() => library.resolve(), /A voz padrão "minha-voz" não existe mais\. Diga qual usar \(ex\.: \/falar @galvao texto\)/);
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

  it('amostra recusada pelo servidor vira mensagem clara (motivo + como regravar), não "serviço desligado"', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/get_reference_files')) return new Response('[]');
      return new Response(
        JSON.stringify({ uploaded_files: [], errors: [{ filename: 'galvao-1.wav', error: 'Reference audio duration (30.71s) exceeds maximum allowed (30s).' }] }),
        { status: 400 },
      );
    }) as typeof fetch;
    const cloner = new ChatterboxVoiceCloner({ baseUrl: 'http://localhost:8004', language: 'pt', timeoutMs: 2000 });
    await assert.rejects(
      cloner.synthesize('Gol!', 'galvao', { buffer: silenceWav(6), extension: 'wav', durationSeconds: 6 }),
      (error: unknown) =>
        error instanceof UserFacingError &&
        error.userMessage === 'o Chatterbox recusou a amostra da voz "galvao" (Reference audio duration (30.71s) exceeds maximum allowed (30s)). Grave de novo com /minhavoz galvao, de 10 a 25 segundos.',
    );
  });
});

describe('Apagar voz', () => {
  it('apaga pelo nome (todas as extensões), avisa quando era a padrão e dá erro claro se não existir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozes-'));
    const library = new VoiceLibrary({ dir, defaultVoice: 'minha-voz' }, new AudioSampleConverter());
    await library.save('minha-voz', silenceWav(12), 'wav');
    await library.save('galvao', silenceWav(12), 'wav');
    fs.writeFileSync(path.join(dir, 'galvao.mp3'), 'mp3');
    const service = new VoiceCloneService(library, {} as never);

    assert.equal(service.remove('Galvao'), '🗑️ Voz "galvao" apagada. Restam: minha-voz.');
    assert.deepEqual(fs.readdirSync(dir), ['minha-voz.wav'], 'some o .wav e o .mp3 de mesmo nome');
    assert.equal(service.remove('minha-voz'), '🗑️ Voz "minha-voz" apagada. Nenhuma voz cadastrada agora. Ela era a voz padrão: grave outra com /minhavoz minha-voz.');
    assert.throws(() => service.remove('raul'), (e: unknown) => e instanceof VoiceNotFoundError && /Voz "raul" não encontrada\. Nenhuma voz cadastrada\./.test(e.userMessage));
  });
});

describe('Limite da amostra de referência', () => {
  it('WAV acima de 25 s é cortado nos primeiros 25 s (cadastro e amostras antigas), sem mexer nos menores', async () => {
    const converter = new AudioSampleConverter();
    const long = await converter.toReferenceAudio(silenceWav(31), 'wav');
    assert.equal(long.durationSeconds, 25);
    assert.equal(long.trimmedFromSeconds, 31);
    assert.equal(AudioSampleConverter.wavDuration(long.buffer), 25, 'o cabeçalho do WAV cortado bate com o conteúdo');
    const short = await converter.toReferenceAudio(silenceWav(12), 'wav');
    assert.deepEqual([short.durationSeconds, short.trimmedFromSeconds], [12, undefined]);
    assert.equal(AudioSampleConverter.trimWav(Buffer.from('não é wav'), 5), null);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vozes-'));
    const saved = await new VoiceLibrary({ dir }, converter).save('galvao', silenceWav(31), 'wav');
    assert.deepEqual([saved.durationSeconds, saved.trimmedFromSeconds], [25, 31]);
    assert.equal(AudioSampleConverter.wavDuration(fs.readFileSync(saved.sample.filePath)), 25);
  });
});

describe('Saída com voz clonada', () => {
  it('VoiceCloneTagParser separa os trechos falados do texto', () => {
    const parsed = VoiceCloneTagParser.parse('Aqui está 👇\n<voz_clonada voz="parreira">Oi Maria, feliz aniversário!</voz_clonada>');
    assert.equal(parsed.text, 'Aqui está 👇');
    assert.deepEqual(parsed.segments, [{ voice: 'parreira', text: 'Oi Maria, feliz aniversário!' }]);
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
    await output.send(1, { text: 'Pronto!\n<voz_clonada voz="parreira">Chego às oito.</voz_clonada>', isAudio: false });
    assert.deepEqual(log, ['text:Pronto!', 'audio:parreira:Chego às oito.']);
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
