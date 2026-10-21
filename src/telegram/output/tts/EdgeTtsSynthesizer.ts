import { EdgeTTS } from 'edge-tts-universal';
import { AudioSynthesisError, errorMessage } from '../../../errors/AppErrors.js';
import { type ITextToSpeech, type SynthesizedAudio, withTtsTimeout } from './TextToSpeech.js';

/** TTS via Microsoft Edge (`edge-tts-universal`, na nuvem), voz padrão pt-BR-Thalita. */
export class EdgeTtsSynthesizer implements ITextToSpeech {
  readonly name = 'edge';

  constructor(
    readonly voice: string,
    private readonly timeoutMs = 25_000,
  ) {}

  async synthesize(text: string): Promise<SynthesizedAudio> {
    try {
      const result = await withTtsTimeout(new EdgeTTS(text, this.voice).synthesize(), this.timeoutMs, 'Edge-TTS');
      const audio = Buffer.from(await result.audio.arrayBuffer());
      if (audio.length === 0) throw new AudioSynthesisError('Edge-TTS retornou áudio vazio');
      return { audio, format: 'mp3' };
    } catch (error) {
      if (error instanceof AudioSynthesisError) throw error;
      throw new AudioSynthesisError(`Edge-TTS falhou: ${errorMessage(error)}`, { cause: error });
    }
  }
}
