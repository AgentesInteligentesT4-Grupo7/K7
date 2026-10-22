import type { ITextToSpeech, SynthesizedAudio } from './tts/TextToSpeech.js';
import { Logger } from '../utils/Logger.js';
import type { ChatterboxVoiceCloner } from './ChatterboxVoiceCloner.js';
import type { VoiceLibrary, VoiceSample } from './VoiceLibrary.js';

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

  enroll(name: string, audio: Buffer, extension: string):Promise<{ sample: VoiceSample; durationSeconds: number | null; trimmedFromSeconds?: number }> {
    return this.library.save(name, audio, extension);
  }

  async speak(text: string, voiceName?: string): Promise<SynthesizedAudio & { voice: string }> {
    const sample = this.library.resolve(voiceName);
    const started = Date.now();
    const result = await this.cloner.synthesize(text, sample.name, await this.library.load(sample));
    this.logger.info(`🗣️ Voz clonada "${sample.name}" (${text.length} chars, ${Date.now() - started}ms)`);
    return { ...result, voice: sample.name };
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
