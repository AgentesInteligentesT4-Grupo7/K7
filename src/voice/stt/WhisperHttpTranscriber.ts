import fs from 'node:fs';
import path from 'node:path';
import { TranscriptionFailedError, WhisperUnavailableError, errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { type ISpeechToText, WhisperTranscriber } from './WhisperTranscriber.js';

export interface WhisperHttpOptions {
  /** Servidor compatível com OpenAI `/audio/transcriptions` (ex.: Speaches/faster-whisper na GPU). */
  baseUrl: string;
  model: string;
  language: string;
  timeoutMs: number;
}

/**
 * Whisper local via HTTP (container faster-whisper na GPU). O áudio continua na
 * máquina: a requisição vai para localhost. O servidor decodifica OGG/Opus do
 * Telegram sozinho, sem ffmpeg no Windows.
 */
export class WhisperHttpTranscriber implements ISpeechToText {
  private readonly logger = new Logger('Whisper');

  constructor(private readonly options: WhisperHttpOptions) {}

  async transcribe(audioPath: string): Promise<string> {
    const started = Date.now();
    const audio = await fs.promises.readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([audio]), path.basename(audioPath));
    form.append('model', this.options.model);
    form.append('language', this.options.language);
    form.append('response_format', 'json');

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new TranscriptionFailedError(`timeout após ${this.options.timeoutMs}ms`, error);
      }
      throw new WhisperUnavailableError(`servidor inacessível em ${this.options.baseUrl}: ${errorMessage(error)}`, error);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new TranscriptionFailedError(`HTTP ${response.status}: ${detail}`);
    }

    const data = (await response.json()) as { text?: string };
    const text = WhisperTranscriber.clean(data.text ?? '');
    this.logger.info(`🎙️ Transcript (${((Date.now() - started) / 1000).toFixed(1)}s): ${text || '(vazio)'}`);
    return text;
  }

  /** Confere se o servidor responde. */
  async healthCheck(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new WhisperUnavailableError(`servidor inacessível em ${this.options.baseUrl} (o container está rodando?)`, error);
    }
    if (!response.ok) throw new WhisperUnavailableError(`HTTP ${response.status} ao consultar ${this.options.baseUrl}/models`);
  }
}
