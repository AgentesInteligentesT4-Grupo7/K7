import fs from 'node:fs';
import { UserFacingError } from '../errors/AppErrors.js';
import type { TempFileManager } from '../utils/TempFileManager.js';
import { AudioSampleConverter, type ReferenceAudio } from './AudioSampleConverter.js';
import type { ISpeechToText } from './stt/WhisperTranscriber.js';
import type { SynthesizedAudio } from './tts/TextToSpeech.js';
import type { VoiceCloneService } from './VoiceCloneService.js';
import { type VoiceParams, describeParams } from './VoiceParams.js';

/** Áudio enviado já transcrito e convertido em referência (feito uma vez; os ajustes só geram de novo). */
export interface MirrorSource {
  reference: ReferenceAudio;
  transcript: string;
  /** Duração do áudio enviado (null se o formato não informar, ex.: mp3). */
  originalSeconds: number | null;
}

export interface MirrorResult {
  audio: SynthesizedAudio;
  generatedSeconds: number | null;
  /** Transcrição do áudio gerado (confere se dá para entender o que foi dito). */
  retranscript: string;
  /** Palavras em comum, na mesma ordem, entre as duas transcrições (0–1). */
  wordMatch: number;
}

/** Nome da voz temporária no Chatterbox: o teste não cria voz em data/voices. */
export const MIRROR_VOICE = 'teste-espelho';

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Semelhança por maior subsequência comum de palavras, sobre o tamanho da maior transcrição. */
export function wordSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return x.length === y.length ? 1 : 0;
  let previous = new Array<number>(y.length + 1).fill(0);
  for (const wx of x) {
    const current = [0];
    for (let j = 1; j <= y.length; j++) current[j] = wx === y[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    previous = current;
  }
  return previous[y.length]! / Math.max(x.length, y.length);
}

const seconds = (v: number | null) => (v === null ? '?' : `${v.toFixed(1).replace('.', ',')} s`);

/**
 * Teste "espelho" da voz clonada: o áudio enviado é transcrito, vira a referência da clonagem e a
 * transcrição é falada de novo com ela. Mede a duração e transcreve o resultado para comparar.
 * A entonação geral vem da amostra; a entonação palavra por palavra exigiria conversão de voz.
 */
export class VoiceMirror {
  /** Só mede: não corta o áudio gerado. */
  private readonly meter = new AudioSampleConverter(Number.POSITIVE_INFINITY);

  constructor(
    private readonly service: VoiceCloneService,
    private readonly stt: ISpeechToText,
    private readonly tmp: TempFileManager,
    private readonly converter = new AudioSampleConverter(),
  ) {}

  async prepare(audioPath: string, extension: string): Promise<MirrorSource> {
    const reference = await this.converter.toReferenceAudio(fs.readFileSync(audioPath), extension);
    const transcript = (await this.stt.transcribe(audioPath)).trim();
    if (!transcript) throw new UserFacingError('Não entendi fala nesse áudio. Envie um trecho com alguém falando, sem música alta.');
    return { reference, transcript, originalSeconds: reference.trimmedFromSeconds ?? reference.durationSeconds };
  }

  /** Gera o texto do áudio enviado com a própria amostra dele ou, com `voice`, com uma voz cadastrada. */
  async render(source: MirrorSource, params: VoiceParams, voice?: string): Promise<MirrorResult> {
    const audio = voice
      ? await this.service.speak(source.transcript, voice, params, { direction: false })
      : await this.service.speakWithReference(source.transcript, MIRROR_VOICE, source.reference, params);
    const generatedSeconds = await this.duration(audio);
    const retranscript = await this.transcribe(audio);
    return { audio, generatedSeconds, retranscript, wordMatch: wordSimilarity(source.transcript, retranscript) };
  }

  async duration(audio: SynthesizedAudio): Promise<number | null> {
    try {
      return (await this.meter.toReferenceAudio(audio.audio, audio.format)).durationSeconds;
    } catch {
      return null;
    }
  }

  private async transcribe(audio: SynthesizedAudio): Promise<string> {
    const generatedPath = this.tmp.createPath(`.${audio.format}`);
    fs.writeFileSync(generatedPath, audio.audio);
    try {
      return (await this.stt.transcribe(generatedPath)).trim();
    } catch {
      return '';
    } finally {
      await this.tmp.remove(generatedPath);
    }
  }

  /** Relatório para o usuário (texto puro: Telegram e terminal). */
  static report(source: MirrorSource, result: MirrorResult, params: VoiceParams, changes: string[] = [], voice?: string): string {
    const o = source.originalSeconds;
    const g = result.generatedSeconds;
    const pct = o && g ? Math.round(((g - o) / o) * 100) : undefined;
    const diff = pct === undefined ? 'sem medida' : `${pct > 0 ? '+' : ''}${pct}%`;
    const ref = source.reference.durationSeconds;
    const trimmed = ref !== null && o !== null && o > ref ? ` (amostra usada: primeiros ${seconds(ref)})` : '';
    const match = Math.round(result.wordMatch * 100);
    const verdict = match >= 90 ? 'fala clara' : match >= 70 ? 'entendível, com trocas de palavras' : 'difícil de entender: tente uma amostra mais limpa';
    return [
      changes.length
        ? `🎚️ Ajuste: ${changes.join(', ')}`
        : voice
          ? `🧪 Teste: o texto do áudio enviado falado com a voz "${voice}"`
          : '🧪 Teste da voz clonada (espelho: o áudio enviado é a própria amostra)',
      changes.length ? '' : `📝 Transcrição do original:\n${source.transcript}\n`,
      `⏱️ Duração: original ${seconds(o)}${trimmed} · gerado ${seconds(g)} (${diff})`,
      `🔁 Gerado transcrito de novo: ${match}% das palavras iguais (${verdict})`,
      result.retranscript && match < 100 ? `   Ouvido no gerado: ${result.retranscript}` : '',
      `🎛️ ${describeParams(params)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
