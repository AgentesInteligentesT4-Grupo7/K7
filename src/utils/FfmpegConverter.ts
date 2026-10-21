import { Logger } from './Logger.js';
import { ProcessNotFoundError, type ProcessRunner } from './ProcessRunner.js';

/** Conversões de áudio via ffmpeg (entrada para o Whisper, saída para voice note OGG/Opus). */
export class FfmpegConverter {
  private readonly logger = new Logger('ffmpeg');
  private available: boolean | undefined;

  constructor(
    private readonly bin: string,
    private readonly runner: ProcessRunner,
    private readonly timeoutMs = 60_000,
  ) {}

  /** WAV 16kHz mono PCM — formato exigido pelo whisper.cpp. */
  toWav16k(input: string, output: string): Promise<void> {
    return this.convert(['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output]);
  }

  /** OGG/Opus — formato nativo de voice note do Telegram. */
  toOggOpus(input: string, output: string): Promise<void> {
    return this.convert(['-y', '-i', input, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', output]);
  }

  /** `false` após a primeira tentativa que não encontrou o executável. */
  get isKnownUnavailable(): boolean {
    return this.available === false;
  }

  private async convert(args: string[]): Promise<void> {
    try {
      const result = await this.runner.run(this.bin, ['-hide_banner', '-loglevel', 'error', ...args], this.timeoutMs);
      if (result.code !== 0) throw new Error(`ffmpeg saiu com código ${result.code}: ${result.stderr.slice(-300)}`);
      this.available = true;
    } catch (error) {
      if (error instanceof ProcessNotFoundError) {
        if (this.available !== false) this.logger.warn(`ffmpeg não encontrado ("${this.bin}"). Configure FFMPEG_BIN.`);
        this.available = false;
      }
      throw error;
    }
  }
}
