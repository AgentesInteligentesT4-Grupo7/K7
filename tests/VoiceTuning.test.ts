import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { Message } from 'grammy/types';
import { audioMedia, isAudioDocument } from '../src/canais/telegram/VoiceCloneCommands.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';
import { AudioSampleConverter, type ReferenceAudio } from '../src/voice/AudioSampleConverter.js';
import { ChatterboxVoiceCloner } from '../src/voice/ChatterboxVoiceCloner.js';
import type { VoiceCloneService } from '../src/voice/VoiceCloneService.js';
import { VoiceLibrary } from '../src/voice/VoiceLibrary.js';
import { VoiceMirror, wordSimilarity } from '../src/voice/VoiceMirror.js';
import { type VoiceParams, describeParams, parseAdjustment, speedToMatch } from '../src/voice/VoiceParams.js';
import { VoiceTuner } from '../src/voice/VoiceTuner.js';

const silenceWav = (seconds: number) => AudioSampleConverter.encodeWav([new Float32Array(Math.round(24_000 * seconds))], 24_000);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ajuste-voz-'));

describe('Ajustes da voz: interpretação', () => {
  it('entende pedidos em português, tons prontos e números; acumula sobre o atual', () => {
    const a = parseAdjustment('quero mais emoção e mais lento', {});
    assert.deepEqual([a.params.exaggeration, a.params.speedFactor], [0.75, 0.9]);
    assert.deepEqual(a.changes, ['mais emoção (0,5 → 0,75)', 'mais lento (1 → 0,9)']);
    const b = parseAdjustment('mais emoção', a.params);
    assert.equal(b.params.exaggeration, 1, 'soma ao ajuste anterior');
    assert.deepEqual(parseAdjustment('narrador', {}).params, { exaggeration: 1.2, cfgWeight: 0.3, temperature: 0.85 });
    assert.deepEqual(parseAdjustment('emocao=0,9 ritmo=0.3 velocidade=5', {}).params, { exaggeration: 0.9, cfgWeight: 0.3, speedFactor: 1.5 }, 'limita a velocidade');
    assert.equal(parseAdjustment('outra versão', { seed: 7 }, () => 0.5).params.seed, 1_000_000_001);
    assert.equal(parseAdjustment('igualar a duração', {}).matchDuration, true);
    assert.deepEqual(parseAdjustment('sei lá', {}).changes, []);
    assert.equal(speedToMatch({}, 12, 10), 1.2);
    assert.equal(speedToMatch({ speedFactor: 0.9 }, 8, 10), 0.72);
    assert.equal(describeParams({ exaggeration: 0.75 }), 'emoção 0,75 · ritmo 0,5 · velocidade 1,0 · variação 0,8');
  });

  it('semelhança de palavras ignora acentos e pontuação', () => {
    assert.equal(wordSimilarity('Olá, mundo! Tudo bem?', 'ola mundo tudo bem'), 1);
    assert.equal(wordSimilarity('o gato subiu no telhado', 'o rato subiu no telhado'), 0.8);
    assert.equal(wordSimilarity('abc', ''), 0);
  });
});

describe('Ajustes da voz: sessão de teste', () => {
  /** Serviço falso: a duração gerada depende da velocidade (10 s × 1,2 / velocidade). */
  function fakes() {
    const calls: Array<{ kind: string; text: string; voice?: string; params: VoiceParams }> = [];
    const saved: Record<string, unknown> = {};
    const generate = (params: VoiceParams) => ({ audio: silenceWav(12 / (params.speedFactor ?? 1)), format: 'wav' as const });
    const service = {
      speakWithReference: async (text: string, _label: string, _ref: ReferenceAudio, params: VoiceParams) => (calls.push({ kind: 'ref', text, params: { ...params } }), generate(params)),
      speak: async (text: string, voice: string, params: VoiceParams) => (calls.push({ kind: 'voz', text, voice, params: { ...params } }), { ...generate(params), voice, params }),
      resolveName: (name?: string) => {
        if (name && name !== 'minha-voz') throw new Error(`Voz "${name}" não encontrada`);
        return 'minha-voz';
      },
      params: () => ({ exaggeration: 0.6 }),
      saveVoice: (name: string, _ref: ReferenceAudio, params: VoiceParams) => ((saved.voice = { name, params }), { name, filePath: `${name}.wav` }),
      saveParams: (name: string, params: VoiceParams) => (saved.params = { name, params }),
    } as unknown as VoiceCloneService;
    const transcripts = ['Olá, este é um teste da voz.', 'ola este e um teste da voz', 'ola este e um teste da voz', 'ola este e um teste da voz'];
    const stt = { transcribe: async () => transcripts.shift() ?? '' };
    const dir = tmpDir();
    const tmp = new TempFileManager(path.join(dir, 'tmp'));
    tmp.initialize();
    const original = path.join(dir, 'whatsapp.opus.wav');
    fs.writeFileSync(original, silenceWav(10));
    return { tuner: new VoiceTuner(service, new VoiceMirror(service, stt, tmp)), calls, saved, original };
  }

  it('teste espelho → mede duração e fala → "igualar" acerta a duração com a mesma semente → salvar vira voz nova', async () => {
    const { tuner, calls, saved, original } = fakes();
    const first = await tuner.test('chat', original, '.wav');
    assert.match(first.report, /Teste da voz clonada \(espelho/);
    assert.match(first.report, /Transcrição do original:\nOlá, este é um teste da voz\./);
    assert.match(first.report, /original 10,0 s · gerado 12,0 s \(\+20%\)/);
    assert.match(first.report, /100% das palavras iguais \(fala clara\)/);
    assert.match(first.report, /Não gostou\? \/ajustar/);

    const fixed = await tuner.adjust('chat', 'igualar');
    assert.match(fixed.report, /Ajuste: igualar a duração \(velocidade 1,2\)/);
    assert.match(fixed.report, /gerado 10,0 s \(0%\)/);
    assert.equal(calls[1]!.params.seed, calls[0]!.params.seed, 'mesma semente entre os ajustes');
    assert.equal(calls[1]!.text, 'Olá, este é um teste da voz.', 'não transcreve o original de novo');

    await tuner.adjust('chat', 'mais emoção');
    assert.deepEqual([calls[2]!.params.exaggeration, calls[2]!.params.speedFactor], [0.75, 1.2]);
    assert.throws(() => tuner.save('chat'), /Dê um nome para a voz/);
    assert.match(tuner.save('chat', 'Minha Voz 2'), /Voz "Minha Voz 2" salva/);
    assert.deepEqual(saved.voice, { name: 'Minha Voz 2', params: { exaggeration: 0.75, speedFactor: 1.2 } }, 'a semente não é salva');
  });

  it('com @voz: fala o texto do áudio com a voz cadastrada; salvar guarda os ajustes nela; /falar também ajusta', async () => {
    const { tuner, calls, saved, original } = fakes();
    const out = await tuner.test('chat', original, '.wav', 'minha-voz');
    assert.match(out.report, /falado com a voz "minha-voz"/);
    assert.deepEqual([calls[0]!.kind, calls[0]!.voice, calls[0]!.params.exaggeration], ['voz', 'minha-voz', 0.6], 'parte dos ajustes salvos da voz');
    await tuner.adjust('chat', 'calmo');
    assert.match(tuner.save('chat'), /Ajustes salvos na voz "minha-voz"/);
    assert.deepEqual(saved.params, { name: 'minha-voz', params: { exaggeration: 0.3, cfgWeight: 0.6, speedFactor: 0.95 } });

    tuner.remember('outro-chat', 'Bom dia!', undefined);
    const spoken = await tuner.adjust('outro-chat', 'mais rápido');
    assert.match(spoken.report, /Ajuste: mais rápido \(1 → 1,1\)/);
    await assert.rejects(tuner.adjust('outro-chat', 'igualar'), /use depois de um \/testarvoz/);
    await assert.rejects(tuner.adjust('sem-sessao', 'mais lento'), /Nada para ajustar agora/);
    await assert.rejects(tuner.adjust('chat', 'blá'), /Não entendi o ajuste "blá"/);
  });
});

describe('Ajustes da voz: Chatterbox, biblioteca e anexos de áudio', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('envia só os parâmetros ajustados, com os nomes do servidor', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/get_reference_files')) return new Response('[]');
      if (url.endsWith('/upload_reference')) return new Response('{}');
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(Buffer.from('OggS'));
    }) as typeof fetch;
    const cloner = new ChatterboxVoiceCloner({ baseUrl: 'http://x', language: 'pt', timeoutMs: 1000 });
    const ref = { buffer: silenceWav(5), extension: 'wav' as const, durationSeconds: 5 };
    await cloner.synthesize('a', 'v', ref, { exaggeration: 0.9, cfgWeight: 0.3, speedFactor: 0.9, seed: 42 });
    await cloner.synthesize('b', 'v', ref);
    assert.deepEqual([bodies[0]!.exaggeration, bodies[0]!.cfg_weight, bodies[0]!.speed_factor, bodies[0]!.seed, bodies[0]!.temperature], [0.9, 0.3, 0.9, 42, undefined]);
    assert.equal('exaggeration' in bodies[1]!, false, 'sem ajuste, o padrão do servidor');
  });

  it('a voz guarda os ajustes num .json ao lado do áudio; apagar a voz apaga o .json', async () => {
    const dir = tmpDir();
    const library = new VoiceLibrary({ dir }, new AudioSampleConverter());
    await library.save('galvao', silenceWav(12), 'wav');
    library.saveParams('galvao', { exaggeration: 9, cfgWeight: 0.3, seed: 5 });
    assert.deepEqual(library.params('galvao'), { exaggeration: 2, cfgWeight: 0.3, seed: 5 }, 'valores fora da faixa são limitados');
    assert.deepEqual(library.list().map((v) => v.name), ['galvao'], 'o .json não vira voz');
    library.remove('galvao');
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(library.params('galvao'), {});
  });

  it('áudio anexado como arquivo (WhatsApp .opus, .mp3, mime audio/*) é reconhecido como áudio', () => {
    assert.equal(isAudioDocument({ file_name: 'PTT-20261022-WA0001.opus' }), true);
    assert.equal(isAudioDocument({ file_name: 'gravacao', mime_type: 'audio/ogg' }), true);
    assert.equal(isAudioDocument({ file_name: 'relatorio.pdf', mime_type: 'application/pdf' }), false);
    const doc = { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, document: { file_id: 'f1', file_unique_id: 'u', file_name: 'PTT-WA0001.opus' } } as unknown as Message;
    assert.deepEqual(audioMedia(doc), { fileId: 'f1', extension: '.opus' });
    const voice = { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, voice: { file_id: 'v1', file_unique_id: 'u', duration: 3 } } as unknown as Message;
    assert.deepEqual(audioMedia(voice), { fileId: 'v1', extension: '.ogg' });
    const pdf = { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, document: { file_id: 'p', file_unique_id: 'u', file_name: 'a.pdf', mime_type: 'application/pdf' } } as unknown as Message;
    assert.equal(audioMedia(pdf), undefined);
  });
});
