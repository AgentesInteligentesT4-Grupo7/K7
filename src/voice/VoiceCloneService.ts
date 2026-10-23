import type { ITextToSpeech, SynthesizedAudio } from './tts/TextToSpeech.js';
import { AudioSynthesisError, UserFacingError } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import type { ReferenceAudio } from './AudioSampleConverter.js';
import type { ChatterboxVoiceCloner } from './ChatterboxVoiceCloner.js';
import { type OggOpusPart, concatOggOpus } from './OggOpusConcat.js';
import { type SpeechSegment, mergeShortSegments, parseDirection, segmentParams } from './SpeechDirection.js';
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
      result = await this.cloner.synthesize(segments[0]!.text, sample.name, reference, segmentParams(params, segments[0]!));
    } else {
      // Mesma semente em todos os trechos: o timbre não muda de um para o outro.
      const seed = params.seed ?? newSeed();
      const parts: OggOpusPart[] = [];
      for (const [index, segment] of segments.entries()) {
        const piece = await this.cloner.synthesize(segment.text, sample.name, reference, { ...segmentParams(params, segment), seed });
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

  /** Trechos a gerar: as marcações do texto ou, sem elas e no modo auto, as que o LLM local escrever. */
  private async plan(text: string, direct: boolean): Promise<{ segments: SpeechSegment[]; script?: string }> {
    const whole: SpeechSegment[] = [{ text, params: {}, styles: [], pauseAfterMs: 0 }];
    if (!direct || this.direction === 'off') return { segments: whole };
    const written = parseDirection(text);
    if (written.directed) {
      if (!written.segments.length) throw new UserFacingError('Só encontrei marcações (como "(pausa)"), nenhum texto para falar.');
      return { segments: mergeShortSegments(written.segments) };
    }
    if (this.direction !== 'auto' || !this.director) return { segments: whole };
    const script = await this.director.direct(text);
    const directed = parseDirection(script);
    return directed.directed && directed.segments.length ? { segments: mergeShortSegments(directed.segments), script } : { segments: whole };
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
