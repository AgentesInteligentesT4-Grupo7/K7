import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { AudioSampleConverter } from '../src/voice/AudioSampleConverter.js';
import type { ChatterboxVoiceCloner } from '../src/voice/ChatterboxVoiceCloner.js';
import { concatOggOpus, oggPackets, opusPacketSamples, writeOggOpus } from '../src/voice/OggOpusConcat.js';
import { extractContext, mergeShortSegments, parseDirection, segmentParams, stripDirection } from '../src/voice/SpeechDirection.js';
import { SpeechDirector } from '../src/voice/SpeechDirector.js';
import { VoiceCloneService } from '../src/voice/VoiceCloneService.js';
import { VoiceLibrary } from '../src/voice/VoiceLibrary.js';
import type { VoiceParams } from '../src/voice/VoiceParams.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

const EXAMPLE = 'Que notícia boa, conseguimos. Pessoal! Agora falta resolver o contrato...';

/** Ogg Opus mono de `ms` milissegundos de silêncio (quadros de 20 ms), como o Chatterbox devolveria. */
function silentOgg(ms: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48_000, 12);
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.alloc(8)]);
  return writeOggOpus(head, tags, Array.from({ length: ms / 20 }, () => Buffer.from([0xf8, 0xff, 0xfe])));
}

async function seconds(ogg: Buffer): Promise<number> {
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const decoded = await decoder.decodeFile(new Uint8Array(ogg));
    assert.equal(decoded.errors.length, 0, 'Ogg válido');
    // O pre-skip do Opus (312 amostras = 6,5 ms) sai do total; arredonda para décimos.
    return Math.round((decoded.samplesDecoded / decoded.sampleRate) * 10) / 10;
  } finally {
    decoder.free();
  }
}

describe('Direção da fala: marcações', () => {
  it('divide em trechos com tom, velocidade e pausas; tom vale até o próximo; marcações coladas se somam', () => {
    const script = parseDirection('(rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa longa) (sério)(devagar) Agora falta resolver o contrato. (normal) Fim.');
    assert.equal(script.directed, true);
    assert.deepEqual(
      script.segments.map((s) => [s.text, s.styles.join('+'), s.pauseAfterMs]),
      [
        ['Que notícia boa, conseguimos.', 'rápido+animado', 700],
        ['Pessoal!', 'rápido+animado', 1300],
        ['Agora falta resolver o contrato.', 'sério+devagar', 0],
        ['Fim.', 'normal', 0],
      ],
    );
    assert.deepEqual(script.segments[0]!.params, { speedFactor: 1.2, exaggeration: 0.9, cfgWeight: 0.4 });
  });

  it('pausas com duração, colchetes, reticências no meio e parênteses comuns como texto', () => {
    assert.deepEqual(
      parseDirection('Oi [pausa 1,5s] tudo bem (pausa de 300ms) sim').segments.map((s) => s.pauseAfterMs),
      [1500, 300, 0],
    );
    assert.deepEqual(parseDirection('Um... dois').segments.map((s) => [s.text, s.pauseAfterMs]), [['Um...', 450], ['dois', 0]]);
    const plain = parseDirection('O preço (ver tabela) subiu.');
    assert.equal(plain.directed, false);
    assert.equal(plain.segments[0]!.text, 'O preço (ver tabela) subiu.');
    assert.equal(stripDirection('(calmo) Bom dia. (pausa) Tudo certo?'), 'Bom dia. Tudo certo?');
  });

  it('trecho de uma ou duas palavras entra no vizinho (a pausa antes vira reticências, a depois continua)', () => {
    const merge = (text: string) => mergeShortSegments(parseDirection(text).segments).map((s) => [s.text, s.styles.join('+'), s.pauseAfterMs]);
    assert.deepEqual(merge('(rápido) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa) (sério) Agora falta resolver o contrato.'), [
      ['Que notícia boa, conseguimos... Pessoal!', 'rápido', 700],
      ['Agora falta resolver o contrato.', 'sério', 0],
    ]);
    assert.deepEqual(merge('(animado) Pessoal! (pausa) (calmo) Vem cá ver isso.'), [['Pessoal! Vem cá ver isso.', 'calmo', 0]]);
    assert.deepEqual(merge('Oi. (pausa) Tudo? (pausa) Tudo bem com você?'), [['Oi... Tudo? Tudo bem com você?', '', 0]]);
  });

  it('o tom vence os ajustes da voz e a velocidade se multiplica', () => {
    const [segment] = parseDirection('(rápido, calmo) Olá a todos').segments;
    assert.deepEqual(segmentParams({ exaggeration: 1, speedFactor: 0.9, seed: 5 }, segment!), { exaggeration: 0.35, cfgWeight: 0.55, speedFactor: 1.03, seed: 5 });
  });
});

describe('Direção da fala: junção dos áudios', () => {
  it('junta trechos Ogg Opus com silêncio no meio num voice note válido', async () => {
    const joined = concatOggOpus([silentOgg(1000), { silenceMs: 500 }, silentOgg(2000)]);
    assert.equal(await seconds(joined), 3.5);
    assert.equal(oggPackets(joined).slice(2).reduce((sum, p) => sum + opusPacketSamples(p), 0), 3.5 * 48_000);
    assert.throws(() => concatOggOpus([Buffer.from('OggS')]), /não é Ogg Opus/);
  });
});

describe('Direção da fala: diretor (LLM local) e voz clonada', () => {
  it('aceita só marcações; descarta se o modelo mudar palavras; mesmo texto reaproveita o roteiro', async () => {
    const marked = '(rápido) Que notícia boa, conseguimos. (pausa) Pessoal! (sério) Agora falta resolver o contrato...';
    const llm = new FakeLlmProvider([{ content: `Marcado: ${marked}` }]);
    const director = new SpeechDirector(llm);
    assert.equal(await director.direct(EXAMPLE), marked);
    assert.equal(await director.direct(EXAMPLE), marked, 'do cache');
    assert.equal(llm.requests.length, 1);

    const liar = new SpeechDirector(new FakeLlmProvider([{ content: '(animado) Que notícia ótima! Ganhamos tudo. (pausa) Agora falta resolver o contrato...' }]));
    assert.equal(await liar.direct(EXAMPLE), EXAMPLE, 'palavras mudadas: fala sem direção');
    const down = new SpeechDirector(new FakeLlmProvider([new Error('ollama fora')]));
    assert.equal(await down.direct(EXAMPLE), EXAMPLE);
  });

  it('gera cada trecho com seu tom, a mesma semente e silêncio entre eles; devolve o roteiro do LLM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direcao-voz-'));
    const library = new VoiceLibrary({ dir, defaultVoice: 'minha-voz' }, new AudioSampleConverter());
    await library.save('minha-voz', AudioSampleConverter.encodeWav([new Float32Array(24_000 * 12)], 24_000), 'wav');
    const calls: Array<{ text: string; params: VoiceParams }> = [];
    const cloner = {
      synthesize: async (text: string, _voice: string, _reference: unknown, params: VoiceParams) => {
        calls.push({ text, params });
        return { audio: silentOgg(1000), format: 'ogg' as const };
      },
    } as unknown as ChatterboxVoiceCloner;
    const marked = '(rápido) Que notícia boa, conseguimos. (pausa) Pessoal! (sério) Agora falta resolver o contrato...';
    const service = new VoiceCloneService(library, cloner, 'auto', new SpeechDirector(new FakeLlmProvider([{ content: marked }])));

    const spoken = await service.speak(EXAMPLE);
    assert.equal(spoken.script, marked);
    assert.deepEqual(calls.map((c) => [c.text, c.params.speedFactor]), [['Que notícia boa, conseguimos... Pessoal!', 1.2], ['Agora falta resolver o contrato...', 0.95]]);
    assert.equal(new Set(calls.map((c) => c.params.seed)).size, 1, 'mesma semente');
    assert.equal(await seconds(spoken.audio), 2, '2 trechos de 1 s; a pausa antes de "Pessoal!" virou reticências');

    calls.length = 0;
    const manual = await service.speak('(devagar) Bom dia, pessoal.');
    assert.equal(manual.script, undefined, 'marcações escritas pela pessoa: nada para mostrar');
    assert.deepEqual(calls.map((c) => [c.text, c.params.speedFactor]), [['Bom dia, pessoal.', 0.85]]);

    calls.length = 0;
    await new VoiceCloneService(library, cloner, 'off').speak('(rápido) Oi');
    assert.deepEqual(calls.map((c) => c.text), ['(rápido) Oi'], 'off: texto como está');
    await assert.rejects(service.speak('(pausa)'), /nenhum texto para falar/);
  });
});

describe('Direção da fala: tom descrito, contexto e efeitos', () => {
  it('descrição livre usa o tom pronto citado; sem ele, fica para o LLM; "(como eu disse)" é texto', () => {
    const sick = parseDirection('(voz de pessoa doente) Hoje não vou conseguir ir.').segments[0]!;
    assert.deepEqual([sick.styles, sick.params.speedFactor, sick.description], [['voz de pessoa doente'], 0.85, undefined]);
    const sleepy = parseDirection('(voz de quem acabou de acordar) Bom dia a todos.').segments[0]!;
    assert.equal(sleepy.description, 'voz de quem acabou de acordar');
    assert.deepEqual(sleepy.params, {});
    const plain = parseDirection('Isso, (como eu disse) antes, já foi resolvido.');
    assert.equal(plain.directed, false);
  });

  it('efeitos viram som falado e contam como ritmo decidido; contexto sai do texto falado', () => {
    const script = parseDirection('(contexto: está gripado, de cama) Hoje não vou. (tosse) Desculpa, pessoal.');
    assert.deepEqual([script.directed, script.timed], [true, true]);
    assert.equal(script.segments.map((s) => s.text).join(' '), 'Hoje não vou. Cof, cof... Desculpa, pessoal.');
    assert.deepEqual(extractContext('Contexto: acabou de correr\nOi, tudo bem com vocês?'),{ context: 'acabou de correr', body: 'Oi, tudo bem com vocês?' });
    assert.equal(stripDirection('(contexto: gripado) (doente) Oi. (tosse) (pausa) Tchau, gente.'), 'Oi. Tchau, gente.');
  });

  it('contexto dá o tom aos trechos sem tom; descrição livre vira parâmetros pelo LLM; diretor que apaga o tom escrito é descartado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direcao-voz-'));
    const library = new VoiceLibrary({ dir, defaultVoice: 'minha-voz' }, new AudioSampleConverter());
    await library.save('minha-voz', AudioSampleConverter.encodeWav([new Float32Array(24_000 * 12)], 24_000), 'wav');
    const calls: Array<{ text: string; params: VoiceParams }> = [];
    const cloner = {
      synthesize: async (text: string, _voice: string, _reference: unknown, params: VoiceParams) => {
        calls.push({ text, params });
        return { audio: silentOgg(1000), format: 'ogg' as const };
      },
    } as unknown as ChatterboxVoiceCloner;

    // Modo manual: sem LLM, o contexto "gripado" já soa doente.
    await new VoiceCloneService(library, cloner, 'manual').speak('(contexto: está gripado) Hoje não vou conseguir ir, desculpa.');
    assert.deepEqual([calls[0]!.text, calls[0]!.params.speedFactor, calls[0]!.params.exaggeration], ['Hoje não vou conseguir ir, desculpa.', 0.85, 0.3]);

    // Auto: o diretor recebe o contexto e mantém o tom descrito; o roteiro volta com o contexto na frente.
    calls.length = 0;
    const llm = new FakeLlmProvider([
      { content: '(voz de quem acabou de acordar) Bom dia a todos. (pausa) (bocejo) Já estou indo.' },
      { content: '{"emocao": 0.3, "velocidade": 0.8, "ritmo": 0.3}' },
    ]);
    const service = new VoiceCloneService(library, cloner, 'auto', new SpeechDirector(llm));
    const spoken = await service.speak('(contexto: domingo cedo) (voz de quem acabou de acordar) Bom dia a todos. Já estou indo.');
    assert.equal(spoken.script, '(contexto: domingo cedo) (voz de quem acabou de acordar) Bom dia a todos. (pausa) (bocejo) Já estou indo.');
    assert.match(String(llm.requests[0]!.messages[0]!.content), /Contexto de quem fala: domingo cedo/);
    assert.deepEqual(calls.map((c) => [c.text, c.params.speedFactor, c.params.cfgWeight]), [
      ['Bom dia a todos.', 0.8, 0.3],
      ['Aaahm... Já estou indo.', 0.8, 0.3],
    ]);

    const eraser = new SpeechDirector(new FakeLlmProvider([{ content: '(animado) Bom dia a todos. (pausa) Já estou indo.' }]));
    assert.equal(await eraser.direct('(triste) Bom dia a todos. Já estou indo.'), '(triste) Bom dia a todos. Já estou indo.');
  });
});
