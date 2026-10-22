import fs from 'node:fs';
import path from 'node:path';
import type { WhisperEngine } from '../../config/Config.js';
import { TranscriptionFailedError, WhisperUnavailableError, errorMessage } from '../../errors/AppErrors.js';
import type { FfmpegConverter } from '../../utils/FfmpegConverter.js';
import { Logger } from '../../utils/Logger.js';
import { ProcessNotFoundError, type ProcessRunner, ProcessTimeoutError } from '../../utils/ProcessRunner.js';
import type { TempFileManager } from '../../utils/TempFileManager.js';

/** Contrato de transcrição (STT). Retorna string vazia para áudio mudo. */
export interface ISpeechToText {
  transcribe(audioPath: string): Promise<string>;
  /** Verificação opcional no startup (servidor no ar, modelo disponível). */
  healthCheck?(): Promise<void>;
}

export interface WhisperOptions {
  engine: WhisperEngine;
  bin: string;
  model: string;
  language: string;
  timeoutMs: number;
}

/**
 * Whisper 100% local via processo filho (sem enviar voz para a nuvem).
 * - `openai-whisper`: CLI Python (`pip install openai-whisper`), lê OGG/MP3 direto via ffmpeg.
 * - `whisper-cpp`: `whisper-cli` + modelo ggml; o áudio é convertido para WAV 16kHz antes.
 */
export class WhisperTranscriber implements ISpeechToText {
  private readonly logger = new Logger('Whisper');

  constructor(
    private readonly options: WhisperOptions,
    private readonly runner: ProcessRunner,
    private readonly ffmpeg: FfmpegConverter,
    private readonly tmp: TempFileManager,
  ) {}

  async transcribe(audioPath: string): Promise<string> {
    const outDir = this.tmp.createDir();
    const started = Date.now();
    try {
      const raw =
        this.options.engine === 'whisper-cpp'
          ? await this.runWhisperCpp(audioPath, outDir)
          : await this.runOpenAiWhisper(audioPath, outDir);
      const text = WhisperTranscriber.clean(raw);
      this.logger.info(`🎙️ Transcript (${((Date.now() - started) / 1000).toFixed(1)}s): ${text || '(vazio)'}`);
      return text;
    } catch (error) {
      if (error instanceof ProcessNotFoundError) throw new WhisperUnavailableError(error.message, error);
      if (error instanceof ProcessTimeoutError) throw new TranscriptionFailedError(error.message, error);
      if (error instanceof WhisperUnavailableError || error instanceof TranscriptionFailedError) throw error;
      throw new TranscriptionFailedError(errorMessage(error), error);
    } finally {
      await this.tmp.remove(outDir);
    }
  }

  private async runOpenAiWhisper(audioPath: string, outDir: string): Promise<string> {
    const args = [
      audioPath,
      '--model', this.options.model,
      '--language', this.options.language,
      '--task', 'transcribe',
      '--output_format', 'txt',
      '--output_dir', outDir,
      '--fp16', 'False',
      '--verbose', 'False',
    ];
    const result = await this.runner.run(this.options.bin, args, this.options.timeoutMs);
    if (result.code !== 0) throw new TranscriptionFailedError(`whisper saiu com código ${result.code}: ${result.stderr.slice(-400)}`);
    const txt = path.join(outDir, `${path.parse(audioPath).name}.txt`);
    return fs.promises.readFile(txt, 'utf8');
  }

  private async runWhisperCpp(audioPath: string, outDir: string): Promise<string> {
    const wavPath = path.join(outDir, 'input.wav');
    try {
      await this.ffmpeg.toWav16k(audioPath, wavPath);
    } catch (error) {
      if (error instanceof ProcessNotFoundError) {
        throw new WhisperUnavailableError('ffmpeg não encontrado (necessário para o whisper.cpp)', error);
      }
      throw error;
    }
    const outBase = path.join(outDir, 'transcript');
    const args = ['-m', this.options.model, '-f', wavPath, '-l', this.options.language, '-nt', '-np', '-otxt', '-of', outBase];
    const result = await this.runner.run(this.options.bin, args, this.options.timeoutMs);
    if (result.code !== 0) throw new TranscriptionFailedError(`whisper-cli saiu com código ${result.code}: ${result.stderr.slice(-400)}`);
    return fs.promises.readFile(`${outBase}.txt`, 'utf8').catch(() => result.stdout);
  }

  /** Remove marcadores de silêncio/ruído e normaliza espaços. */
  static clean(raw: string): string {
    return raw
      .replace(/\[(?:BLANK_AUDIO|MUSIC|MÚSICA|SILENCE|SIL[ÊE]NCIO|NOISE|RU[ÍI]DO)\]/gi, '')
      .replace(/\((?:silence|silêncio|music|música)\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
