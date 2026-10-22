import type { ITextToSpeech, SynthesizedAudio } from './tts/TextToSpeech.js';
import { Logger } from '../utils/Logger.js';
import type { ReferenceAudio } from './AudioSampleConverter.js';
import type { ChatterboxVoiceCloner } from './ChatterboxVoiceCloner.js';
import type { VoiceLibrary, VoiceSample } from './VoiceLibrary.js';
import type { VoiceParams } from './VoiceParams.js';

/** Facade da clonagem de voz: cadastra amostras e fala com a voz escolhida. */
export class VoiceCloneService {
  private readonly logger = new Logger('VoiceClone');

  constructor(
    private readonly library: VoiceLibrary,
    private readonly cloner: ChatterboxVoiceCloner,
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

  /** Fala com a voz cadastrada; `override` vence os ajustes salvos dela (usado pelo /ajustar). */
  async speak(text: string, voiceName?: string, override?: VoiceParams): Promise<SynthesizedAudio & { voice: string; params: VoiceParams }> {
    const sample = this.library.resolve(voiceName);
    const params = { ...this.library.params(sample.name), ...override };
    const started = Date.now();
    const result = await this.cloner.synthesize(text, sample.name, await this.library.load(sample), params);
    this.logger.info(`🗣️ Voz clonada "${sample.name}" (${text.length} chars, ${Date.now() - started}ms)`);
    return { ...result, voice: sample.name, params };
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
