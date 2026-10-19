import { AudioSynthesisError, errorMessage } from '../../../errors/AppErrors.js';
import { type ITextToSpeech, type SynthesizedAudio, withTtsTimeout } from './TextToSpeech.js';

export interface KokoroOptions {
  /** Servidor compatível com OpenAI `/audio/speech` (ex.: Kokoro-FastAPI). */
  baseUrl: string;
  /** pt-BR: pf_dora, pm_alex, pm_santa. */
  voice: string;
  speed: number;
  /** Código de idioma do Kokoro ("p" = português do Brasil). */
  langCode: string;
  timeoutMs: number;
}

/**
 * TTS local na GPU com Kokoro (via Kokoro-FastAPI). Pede `opus`, que já chega
 * como OGG/Opus — o formato nativo de voice note do Telegram (sem ffmpeg).
 */
export class KokoroTtsSynthesizer implements ITextToSpeech {
  readonly name = 'kokoro';

  constructor(private readonly options: KokoroOptions) {}

  get voice(): string {
    return this.options.voice;
  }

  async synthesize(text: string): Promise<SynthesizedAudio> {
    const request = async (): Promise<SynthesizedAudio> => {
      let response: Response;
      try {
        response = await fetch(`${this.options.baseUrl}/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kokoro',
            input: text,
            voice: this.options.voice,
            response_format: 'opus',
            speed: this.options.speed,
            lang_code: this.options.langCode,
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        throw new AudioSynthesisError(
          `Kokoro inacessível em ${this.options.baseUrl} (o container está rodando?): ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new AudioSynthesisError(`Kokoro HTTP ${response.status}: ${detail}`);
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) throw new AudioSynthesisError('Kokoro retornou áudio vazio');
      return { audio, format: audio.subarray(0, 4).toString('latin1') === 'OggS' ? 'ogg' : 'mp3' };
    };
    return withTtsTimeout(request(), this.options.timeoutMs, 'Kokoro');
  }

  /** Confere se o servidor responde e se a voz configurada existe. */
  async healthCheck(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/audio/voices`, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new AudioSynthesisError(`Kokoro inacessível em ${this.options.baseUrl}`, { cause: error });
    }
    if (!response.ok) throw new AudioSynthesisError(`Kokoro HTTP ${response.status} ao listar vozes`);
    const data = (await response.json()) as { voices?: Array<string | { id?: string }> };
    const voices = (data.voices ?? []).map((voice) => (typeof voice === 'string' ? voice : voice.id ?? ''));
    if (!voices.includes(this.options.voice)) {
      const portuguese = voices.filter((voice) => /^p[fm]_/.test(voice)).join(', ');
      throw new AudioSynthesisError(`Voz "${this.options.voice}" não existe no Kokoro. Vozes pt-BR: ${portuguese || 'nenhuma'}`);
    }
  }
}
