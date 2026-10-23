import type { ITextToSpeech, SynthesizedAudio } from './tts/TextToSpeech.js';
import { AudioSynthesisError, UserFacingError } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import type { ReferenceAudio } from './AudioSampleConverter.js';
import type { ChatterboxVoiceCloner } from './ChatterboxVoiceCloner.js';
import { type OggOpusPart, concatOggOpus, oggPackets, opusPacketSamples } from './OggOpusConcat.js';
import {
  type SpeechSegment,
  extractContext,
  mergeShortSegments,
  mergeStyles,
  parseDirection,
  segmentParams,
  toneFromKeywords,
} from './SpeechDirection.js';
import type { SpeechDirector } from './SpeechDirector.js';
import type { VoiceLibrary, VoiceSample } from './VoiceLibrary.js';
import type { VoiceParams } from './VoiceParams.js';

/**
 * Direção da fala (VOICE_CLONE_DIRECTION): `auto` = marcações do texto ou, sem elas, o LLM local dirige;
 * `manual` = só as marcações escritas; `off` = o texto é falado como está, de uma vez.
 */
export type SpeechDirectionMode = 'auto' | 'manual' | 'off';

export interface ClonedSpeech extends SynthesizedAudio {
  voice: string;
  params: VoiceParams;
}

const newSeed = () => 1 + Math.floor(Math.random() * 2_000_000_000);

/** Fala normal em português sai a ~13 caracteres por segundo; o tom doente, ~1,3× mais longa. */
const CHARS_PER_SECOND = 13;
/** Acima disso (vezes a duração esperada) a fala foi esticada pelo modelo. */
const MAX_STRETCH = 1.6;
/** Duração de um Ogg Opus pelos pacotes, sem decodificar. */
const oggSeconds = (audio: Buffer) => oggPackets(audio).slice(2).reduce((sum, packet) => sum + opusPacketSamples(packet), 0) / 48_000;

/** Facade da clonagem de voz: cadastra amostras e fala com a voz escolhida. */
export class VoiceCloneService {
  private readonly logger = new Logger('VoiceClone');

  constructor(
    private readonly library: VoiceLibrary,
    private readonly cloner: ChatterboxVoiceCloner,
    private readonly direction: SpeechDirectionMode = 'manual',
    private readonly director?: SpeechDirector,
  ) {}

  get voicesDir(): string {
    return this.library.dir;
  }

  list(): VoiceSample[] {
    return this.library.list();
  }

  /** Apaga a voz e devolve a mensagem para o usuário (a mesma no Telegram e no terminal). */
  remove(name: string): string {
    const { removed, wasDefault, remaining } = this.library.remove(name);
    const left = remaining.length ? `Restam: ${remaining.map((v) => v.name).join(', ')}.` : 'Nenhuma voz cadastrada agora.';
    const hint = wasDefault
      ? remaining.length
        ? ` Ela era a voz padrão: agora use /falar @nome, ou grave outra com /minhavoz ${removed}.`
        : ` Ela era a voz padrão: grave outra com /minhavoz ${removed}.`
      : '';
    return `🗑️ Voz "${removed}" apagada. ${left}${hint}`;
  }

  enroll(name: string, audio: Buffer, extension: string): Promise<{ sample: VoiceSample; durationSeconds: number | null; trimmedFromSeconds?: number }> {
    return this.library.save(name, audio, extension);
  }

  /** Nome canônico da voz (padrão ou única, se nenhum for dado). */
  resolveName(voiceName?: string): string {
    return this.library.resolve(voiceName).name;
  }

  /** Ajustes salvos da voz (`<nome>.json`). */
  params(voiceName: string): VoiceParams {
    return this.library.params(voiceName);
  }

  saveParams(voiceName: string, params: VoiceParams): void {
    this.library.saveParams(voiceName, params);
  }

  /** Guarda uma amostra já preparada (ex.: do teste espelho) como voz, com os ajustes. */
  saveVoice(name: string, reference: ReferenceAudio, params: VoiceParams): VoiceSample {
    const sample = this.library.saveReference(name, reference);
    this.library.saveParams(sample.name, params);
    return sample;
  }

  /**
   * Fala com a voz cadastrada; `override` vence os ajustes salvos dela (usado pelo /ajustar).
   * Com direção, cada trecho sai com seu tom e velocidade, e as pausas viram silêncio entre eles;
   * `script` volta quando o roteiro foi escrito pelo LLM (para a pessoa copiar e editar).
   */
  async speak(text: string, voiceName?: string, override?: VoiceParams, options: { direction?: boolean } = {}): Promise<ClonedSpeech> {
    const sample = this.library.resolve(voiceName);
    const params = { ...this.library.params(sample.name), ...override };
    const started = Date.now();
    const reference = await this.library.load(sample);
    const { segments, script } = await this.plan(text, options.direction !== false);
    let result: SynthesizedAudio;
    if (segments.length === 1) {
      result = await this.synthesizeChecked(segments[0]!.text, sample.name, reference, segmentParams(params, segments[0]!));
    } else {
      // Mesma semente em todos os trechos: o timbre não muda de um para o outro.
      const seed = params.seed ?? newSeed();
      const parts: OggOpusPart[] = [];
      for (const [index, segment] of segments.entries()) {
        const piece = await this.synthesizeChecked(segment.text, sample.name, reference, { ...segmentParams(params, segment), seed });
        if (piece.format !== 'ogg') throw new AudioSynthesisError('Chatterbox não devolveu Ogg Opus para juntar os trechos');
        parts.push(piece.audio);
        if (segment.pauseAfterMs && index < segments.length - 1) parts.push({ silenceMs: segment.pauseAfterMs });
      }
      result = { audio: concatOggOpus(parts), format: 'ogg' };
    }
    const directed = segments.length > 1 || segments[0]!.styles.length ? `, ${segments.length} trecho(s) dirigidos` : '';
    this.logger.info(`🗣️ Voz clonada "${sample.name}" (${text.length} chars${directed}, ${Date.now() - started}ms)`);
    return { ...result, voice: sample.name, params, ...(script ? { script } : {}) };
  }

  /**
   * Gera e confere a duração: às vezes o Chatterbox não termina a fala e a estica (repete sons, arrasta).
   * Bem acima do esperado para o tamanho do texto, gera de novo com outra semente e fica com a mais curta.
   */
  private async synthesizeChecked(text: string, voice: string, reference: ReferenceAudio, params: VoiceParams): Promise<SynthesizedAudio> {
    const first = await this.cloner.synthesize(text, voice, reference, params);
    if (first.format !== 'ogg') return first;
    const expected = Math.max(3, text.length / CHARS_PER_SECOND / (params.speedFactor ?? 1));
    const seconds = oggSeconds(first.audio);
    if (seconds <= expected * MAX_STRETCH) return first;
    this.logger.warn(`Fala esticada (${seconds.toFixed(1)}s para ~${expected.toFixed(1)}s esperados): gerando de novo com outra semente`);
    const retry = await this.cloner.synthesize(text, voice, reference, { ...params, seed: (params.seed ?? newSeed()) + 1 });
    return retry.format === 'ogg' && oggSeconds(retry.audio) < seconds ? retry : first;
  }

  /**
   * Trechos a gerar. Se a pessoa não marcou pausas nem efeitos, no modo auto o LLM local organiza o ritmo,
   * mantendo os tons e o contexto que ela escreveu; senão valem só as marcações escritas.
   */
  private async plan(text: string, direct: boolean): Promise<{ segments: SpeechSegment[]; script?: string }> {
    const whole: SpeechSegment[] = [{ text, params: {}, styles: [], pauseAfterMs: 0 }];
    if (!direct || this.direction === 'off') return { segments: whole };
    const { context, body } = extractContext(text);
    let parsed = parseDirection(text);
    let script: string | undefined;
    if (!parsed.timed && this.direction === 'auto' && this.director) {
      const directed = await this.director.direct(body, context);
      if (directed !== body) {
        script = context ? `(contexto: ${context}) ${directed}` : directed;
        parsed = parseDirection(directed);
      }
    }
    if (!parsed.directed && !context) return { segments: whole };
    if (!parsed.segments.length) throw new UserFacingError('Só encontrei marcações (como "(pausa)"), nenhum texto para falar.');
    const segments = mergeShortSegments(await this.resolveTones(parsed.segments, context));
    return script ? { segments, script } : { segments };
  }

  /**
   * Tons descritos à vontade viram parâmetros (tom pronto citado na descrição ou, no modo auto, o LLM local);
   * trechos sem tom nenhum seguem o contexto ("(contexto: está gripado)" soa doente).
   */
  private async resolveTones(segments: SpeechSegment[], context?: string): Promise<SpeechSegment[]> {
    // Só traduz o contexto se algum trecho ficou sem tom (evita uma chamada ao LLM à toa).
    const contextTone =
      context && segments.some((segment) => !segment.styles.length)
        ? (toneFromKeywords(context) ?? (await this.director?.tone(context)) ?? {})
        : {};
    const resolved: SpeechSegment[] = [];
    for (const segment of segments) {
      if (segment.description && this.director) {
        resolved.push({ ...segment, params: mergeStyles(await this.director.tone(segment.description), segment.params) });
      } else if (!segment.styles.length && context) {
        resolved.push({ ...segment, params: contextTone, styles: ['contexto'] });
      } else resolved.push(segment);
    }
    return resolved;
  }

  /** Fala com uma amostra que não está na biblioteca (teste espelho). */
  async speakWithReference(text: string, label: string, reference: ReferenceAudio, params: VoiceParams = {}): Promise<SynthesizedAudio> {
    const started = Date.now();
    const result = await this.cloner.synthesize(text, label, reference, params);
    this.logger.info(`🗣️ Voz de teste "${label}" (${text.length} chars, ${Date.now() - started}ms)`);
    return result;
  }

  /** Adaptador para a AudioOutputStrategy (Strategy de TTS com a voz clonada). */
  asTextToSpeech(voiceName?: string): ITextToSpeech {
    const resolvedName = this.library.resolve(voiceName).name;
    return {
      name: 'voz-clonada',
      voice: resolvedName,
      synthesize: async (text: string) => this.speak(text, resolvedName),
    };
  }

  healthCheck(): Promise<void> {
    return this.cloner.healthCheck();
  }
}
