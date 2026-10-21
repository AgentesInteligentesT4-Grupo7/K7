import fs from 'node:fs';
import { AudioSynthesisError, errorMessage } from '../../../errors/AppErrors.js';
import type { FfmpegConverter } from '../../../utils/FfmpegConverter.js';
import { Logger } from '../../../utils/Logger.js';
import type { TempFileManager } from '../../../utils/TempFileManager.js';
import { stripMarkdown } from '../../../utils/text.js';
import type { ChatActionNotifier } from '../../ChatActionNotifier.js';
import type { TelegramSender } from '../TelegramSender.js';
import type { ITextToSpeech } from '../tts/TextToSpeech.js';
import type { IOutputStrategy } from './OutputStrategy.js';

/**
 * Sintetiza a resposta em voz e envia como voice note.
 * OGG/Opus (Kokoro) vai direto; MP3 (Edge) é convertido para OGG quando há ffmpeg,
 * senão segue como MP3 (também aceito pelo sendVoice).
 * Lança `AudioSynthesisError` para o handler cair no texto.
 */
export class AudioOutputStrategy implements IOutputStrategy<string> {
  private readonly logger = new Logger('AudioOutput');

  constructor(
    private readonly sender: TelegramSender,
    private readonly tmp: TempFileManager,
    private readonly tts: ITextToSpeech,
    private readonly ffmpeg: FfmpegConverter,
    private readonly notifier: ChatActionNotifier,
  ) {}

  /** `tts` opcional substitui o motor padrão nesta chamada (ex.: voz clonada). */
  async send(chatId: number, text: string, tts: ITextToSpeech = this.tts): Promise<void> {
    const speech = stripMarkdown(text);
    if (!speech) throw new AudioSynthesisError('Nada para sintetizar após limpar o Markdown');

    const stopAction = this.notifier.start(chatId, 'record_voice');
    const paths: string[] = [];
    try {
      const started = Date.now();
      const { audio, format } = await tts.synthesize(speech);
      const sourcePath = this.tmp.createPath(`.${format}`);
      paths.push(sourcePath);
      await fs.promises.writeFile(sourcePath, audio);

      let voicePath = sourcePath;
      if (format === 'mp3') {
        const oggPath = this.tmp.createPath('.ogg');
        paths.push(oggPath);
        voicePath = await this.toOgg(sourcePath, oggPath);
      }

      stopAction();
      await this.sender.sendVoice(chatId, voicePath);
      this.logger.info(`🔊 Voice note enviada (${tts.name}/${tts.voice}, ${speech.length} chars, ${Date.now() - started}ms)`);
    } finally {
      stopAction();
      await this.tmp.remove(...paths);
    }
  }

  private async toOgg(mp3Path: string, oggPath: string): Promise<string> {
    if (this.ffmpeg.isKnownUnavailable) return mp3Path;
    try {
      await this.ffmpeg.toOggOpus(mp3Path, oggPath);
      return oggPath;
    } catch (error) {
      this.logger.debug(`Conversão para OGG indisponível, enviando MP3: ${errorMessage(error)}`);
      return mp3Path;
    }
  }
}
