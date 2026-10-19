import fs from 'node:fs';
import path from 'node:path';
import type { Bot, Context, NextFunction } from 'grammy';
import { errorMessage } from '../errors/AppErrors.js';
import type { ChatQueue } from '../utils/ChatQueue.js';
import { Logger } from '../utils/Logger.js';
import type { TempFileManager } from '../utils/TempFileManager.js';
import type { VoiceCloneService } from '../voice/VoiceCloneService.js';
import { VoiceLibrary } from '../voice/VoiceLibrary.js';
import type { ChatActionNotifier } from './ChatActionNotifier.js';
import type { TelegramFileDownloader } from './input/TelegramFileDownloader.js';
import type { TelegramOutputHandler } from './output/TelegramOutputHandler.js';

export interface VoiceCloneCommandsDeps {
  service: VoiceCloneService;
  downloader: TelegramFileDownloader;
  output: TelegramOutputHandler;
  queue: ChatQueue;
  notifier: ChatActionNotifier;
  tmp: TempFileManager;
  defaultVoiceName: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
const AUDIO_DOCUMENT = /\.(ogg|oga|opus|mp3|wav)$/i;

/**
 * Comandos de clonagem de voz:
 *   /minhavoz [nome] — o próximo áudio enviado vira a amostra da voz (salva em VOICE_CLONE_DIR)
 *   /falar [@voz] texto — devolve um voice note com a voz clonada falando exatamente o texto
 *   /vozes — lista as vozes da pasta
 *   /cancelar — cancela o cadastro pendente
 */
export class VoiceCloneCommands {
  private readonly logger = new Logger('VoiceClone');
  private readonly pending = new Map<number, { name: string; expiresAt: number }>();

  constructor(private readonly deps: VoiceCloneCommandsDeps) {}

  register(bot: Bot): void {
    bot.command('minhavoz', (ctx) => this.handleEnroll(ctx));
    bot.command('falar', (ctx) => this.handleSpeak(ctx));
    bot.command('vozes', (ctx) => this.handleList(ctx));
    bot.command('cancelar', (ctx) => this.handleCancel(ctx));
    bot.on(['message:voice', 'message:audio', 'message:document'], (ctx, next) => this.captureSample(ctx, next));
  }

  private async handleEnroll(ctx: Context): Promise<void> {
    const name = VoiceLibrary.sanitizeName(String(ctx.match ?? '').trim() || this.deps.defaultVoiceName);
    this.pending.set(ctx.chat!.id, { name, expiresAt: Date.now() + PENDING_TTL_MS });
    await this.deps.output.notify(
      ctx.chat!.id,
      [
        `🎙️ Pronto para gravar a voz "${name}".`,
        '',
        'Envie agora um áudio de 10 a 30 segundos falando naturalmente, sem música nem barulho de fundo.',
        'Pode ser voice note, ou arquivo .mp3/.wav/.ogg.',
        '',
        'Para cancelar: /cancelar',
      ].join('\n'),
    );
  }

  private async handleSpeak(ctx: Context): Promise<void> {
    const raw = String(ctx.match ?? '').trim();
    const match = /^@(\S+)\s+([\s\S]+)$/.exec(raw);
    const voice = match ? match[1] : undefined;
    const text = (match ? match[2]! : raw).trim();
    if (!text) {
      await this.deps.output.notify(ctx.chat!.id, 'Uso: /falar <texto>  ou  /falar @nome-da-voz <texto>');
      return;
    }
    const chatId = ctx.chat!.id;
    void this.deps.queue.enqueue(chatId, () => this.deps.output.sendClonedVoice(chatId, text, voice));
  }

  private async handleList(ctx: Context): Promise<void> {
    const voices = this.deps.service.list();
    const dir = this.deps.service.voicesDir;
    const text = voices.length
      ? `🗣️ Vozes cadastradas (${voices.length}):\n\n${voices.map((voice) => `- ${voice.name} (${path.basename(voice.filePath)})`).join('\n')}\n\nPasta: ${dir}\nUse: /falar @nome texto`
      : `🗣️ Nenhuma voz cadastrada.\n\nUse /minhavoz e envie um áudio, ou coloque arquivos .wav/.mp3/.ogg em:\n${dir}`;
    await this.deps.output.notify(ctx.chat!.id, text);
  }

  private async handleCancel(ctx: Context): Promise<void> {
    const had = this.pending.delete(ctx.chat!.id);
    await this.deps.output.notify(ctx.chat!.id, had ? 'Cadastro de voz cancelado.' : 'Nenhum cadastro de voz pendente.');
  }

  /** Se há cadastro pendente, o áudio vira amostra; senão segue para o fluxo normal (transcrição). */
  private async captureSample(ctx: Context, next: NextFunction): Promise<void> {
    const chatId = ctx.chat!.id;
    const pending = this.pending.get(chatId);
    if (!pending || pending.expiresAt < Date.now()) {
      if (pending) this.pending.delete(chatId);
      return next();
    }

    const message = ctx.message!;
    const document = message.document;
    if (document && !AUDIO_DOCUMENT.test(document.file_name ?? '')) return next();
    const media = message.voice ?? message.audio ?? document!;
    const extension = message.voice
      ? '.ogg'
      : path.extname((message.audio?.file_name ?? document?.file_name) || '') || (message.audio?.mime_type === 'audio/mpeg' ? '.mp3' : '.ogg');

    void this.deps.queue.enqueue(chatId, async () => {
      const stopAction = this.deps.notifier.start(chatId, 'typing');
      let tmpPath: string | undefined;
      try {
        tmpPath = await this.deps.downloader.download(media.file_id, extension, MAX_SAMPLE_BYTES);
        const { sample, durationSeconds } = await this.deps.service.enroll(pending.name, fs.readFileSync(tmpPath), extension);
        this.pending.delete(chatId);
        const duration = durationSeconds !== null ? ` (${durationSeconds.toFixed(1)}s)` : '';
        this.logger.info(`💾 Voz "${sample.name}" cadastrada${duration} em ${sample.filePath}`);
        await this.deps.output.notify(
          chatId,
          `✅ Voz "${sample.name}" salva${duration}.\n\nAgora é só digitar: /falar <texto>\nOu peça normalmente: "manda isso com a minha voz: ..."`,
        );
      } catch (error) {
        this.logger.warn(`Falha ao cadastrar voz: ${errorMessage(error)}`);
        await this.deps.output.sendError(chatId, error);
        await this.deps.output.notify(chatId, 'Envie outro áudio para tentar de novo, ou /cancelar.');
      } finally {
        stopAction();
        await this.deps.tmp.remove(tmpPath);
      }
    });
  }
}
