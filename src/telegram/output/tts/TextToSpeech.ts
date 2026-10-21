import { AudioSynthesisError, errorMessage } from '../../../errors/AppErrors.js';
import { Logger } from '../../../utils/Logger.js';

export interface SynthesizedAudio {
  audio: Buffer;
  /** `ogg` (Opus) já é o formato nativo de voice note; `mp3` pode precisar de conversão. */
  format: 'ogg' | 'mp3';
}

/** Contrato de síntese de voz (Strategy). Cada motor conhece sua própria voz. */
export interface ITextToSpeech {
  readonly name: string;
  readonly voice: string;
  synthesize(text: string): Promise<SynthesizedAudio>;
  /** Verificação opcional no startup (servidor no ar, voz existente). */
  healthCheck?(): Promise<void>;
}

/** Executa uma promessa com timeout, rejeitando com `AudioSynthesisError`. */
export async function withTtsTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AudioSynthesisError(`${label} excedeu ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tenta os motores em ordem (ex.: Kokoro local → Edge na nuvem). */
export class FallbackTextToSpeech implements ITextToSpeech {
  private readonly logger = new Logger('TTS');

  constructor(private readonly engines: ITextToSpeech[]) {
    if (engines.length === 0) throw new Error('Nenhum motor de TTS configurado');
  }

  get name(): string {
    return this.engines.map((engine) => engine.name).join(' → ');
  }

  get voice(): string {
    return this.engines[0]!.voice;
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const failures: string[] = [];
    for (const engine of this.engines) {
      try {
        return await engine.synthesize(text);
      } catch (error) {
        failures.push(`${engine.name}: ${errorMessage(error)}`);
        this.logger.warn(`TTS ${engine.name} falhou: ${errorMessage(error)}`);
      }
    }
    throw new AudioSynthesisError(`Todos os motores de TTS falharam (${failures.join(' | ')})`);
  }

  async healthCheckAll(): Promise<Array<{ name: string; ok: boolean; error?: unknown }>> {
    return Promise.all(
      this.engines.map(async (engine) => {
        try {
          await engine.healthCheck?.();
          return { name: engine.name, ok: true };
        } catch (error) {
          return { name: engine.name, ok: false, error };
        }
      }),
    );
  }
}
