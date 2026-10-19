import { createHash } from 'node:crypto';
import { AudioSynthesisError, errorMessage } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import type { SynthesizedAudio } from '../telegram/output/tts/TextToSpeech.js';
import type { ReferenceAudio } from './AudioSampleConverter.js';

export interface ChatterboxOptions {
  /** Chatterbox-TTS-Server (ex.: http://localhost:8004). */
  baseUrl: string;
  /** Código de idioma do modelo multilíngue ("pt"). */
  language: string;
  timeoutMs: number;
}

/**
 * Clonagem de voz local na GPU via Chatterbox-TTS-Server (modelo multilíngue).
 * A amostra é enviada uma vez para `/upload_reference` com nome versionado pelo
 * hash do conteúdo — regravar a voz gera um novo arquivo, já que o servidor
 * ignora uploads com nome repetido.
 */
export class ChatterboxVoiceCloner {
  private readonly logger = new Logger('VoiceClone');
  private readonly uploaded = new Set<string>();

  constructor(private readonly options: ChatterboxOptions) {}

  async synthesize(text: string, voiceName: string, reference: ReferenceAudio): Promise<SynthesizedAudio> {
    const referenceFile = await this.ensureUploaded(voiceName, reference);
    const response = await this.fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice_mode: 'clone',
        reference_audio_filename: referenceFile,
        language: this.options.language,
        output_format: 'opus',
        split_text: true,
      }),
    });
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0) throw new AudioSynthesisError('Chatterbox retornou áudio vazio');
    return { audio, format: audio.subarray(0, 4).toString('latin1') === 'OggS' ? 'ogg' : 'mp3' };
  }

  async healthCheck(): Promise<void> {
    await this.fetch('/api/model-info', { method: 'GET' }, 5_000);
  }

  private async ensureUploaded(voiceName: string, reference: ReferenceAudio): Promise<string> {
    const hash = createHash('sha1').update(reference.buffer).digest('hex').slice(0, 10);
    const fileName = `${voiceName}-${hash}.${reference.extension}`;
    if (this.uploaded.has(fileName)) return fileName;

    const existing = (await (await this.fetch('/get_reference_files', { method: 'GET' })).json()) as string[];
    if (!existing.includes(fileName)) {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(reference.buffer)]), fileName);
      await this.fetch('/upload_reference', { method: 'POST', body: form });
      this.logger.info(`📤 Amostra da voz "${voiceName}" enviada ao Chatterbox (${fileName})`);
    }
    this.uploaded.add(fileName);
    return fileName;
  }

  private async fetch(pathname: string, init: RequestInit, timeoutMs = this.options.timeoutMs): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `timeout após ${timeoutMs}ms`
          : `Chatterbox inacessível em ${this.options.baseUrl} (o container está rodando?): ${errorMessage(error)}`;
      throw new AudioSynthesisError(reason, { cause: error });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new AudioSynthesisError(`Chatterbox HTTP ${response.status} em ${pathname}: ${detail}`);
    }
    return response;
  }
}
