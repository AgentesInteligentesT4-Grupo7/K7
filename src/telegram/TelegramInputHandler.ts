import path from 'node:path';
import type { Bot, Context, NextFunction } from 'grammy';
import type { AgentController } from '../agent/AgentController.js';
import type { AgentInput } from '../agent/types.js';
import { type AgentIdentity, DEFAULT_IDENTITY } from '../config/AgentIdentity.js';
import {
  DocumentParseError,
  EmptyAudioError,
  FileTooLargeError,
  UnsupportedAttachmentError,
} from '../errors/AppErrors.js';
import type { ChatQueue } from '../utils/ChatQueue.js';
import { Logger } from '../utils/Logger.js';
import type { TempFileManager } from '../utils/TempFileManager.js';
import { sanitizeText, truncate } from '../utils/text.js';
import type { ChatActionNotifier } from './ChatActionNotifier.js';
import { AudioIntentDetector } from './input/AudioIntentDetector.js';
import type { DocumentExtractor } from './input/DocumentExtractor.js';
import type { TelegramFileDownloader } from './input/TelegramFileDownloader.js';
import type { ISpeechToText } from './input/WhisperTranscriber.js';
import type { ChatAction } from './output/TelegramSender.js';
import type { TelegramOutputHandler } from './output/TelegramOutputHandler.js';

export interface InputHandlerDeps {
  allowedUserIds: ReadonlySet<number>;
  controller: AgentController;
  output: TelegramOutputHandler;
  downloader: TelegramFileDownloader;
  documents: DocumentExtractor;
  stt: ISpeechToText;
  tmp: TempFileManager;
  queue: ChatQueue;
  notifier: ChatActionNotifier;
  maxDocumentBytes: number;
  maxDocumentChars: number;
  voiceId: string;
  /** Comandos extras registrados logo após a whitelist (ex.: clonagem de voz). */
  extraCommands?: Array<{ register(bot: Bot): void }>;
  identity?: AgentIdentity;
}

/** Limite de download da Bot API do Telegram. */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'audio/webm': '.webm',
};

/**
 * Porta de entrada: whitelist no middleware de topo, normalização de
 * texto/PDF/MD/voz em texto e despacho assíncrono (fila por chat) ao AgentController.
 */
export class TelegramInputHandler {
  private readonly logger = new Logger('Input');

  constructor(private readonly deps: InputHandlerDeps) {}

  register(bot: Bot): void {
    // EC-01 (PRD): corta usuários fora da whitelist antes de qualquer acesso a DB/LLM.
    bot.use((ctx, next) => this.whitelist(ctx, next));
    for (const commands of this.deps.extraCommands ?? []) commands.register(bot);

    bot.command('start', (ctx) => this.handleStart(ctx));
    bot.command(['nova', 'new', 'reset'], (ctx) => this.handleNewConversation(ctx));
    bot.command('skills', (ctx) => this.handleListSkills(ctx));

    bot.on('message:text', (ctx) => this.handleText(ctx));
    bot.on('message:document', (ctx) => this.handleDocument(ctx));
    bot.on(['message:voice', 'message:audio'], (ctx) => this.handleAudio(ctx));
    bot.on('message', (ctx) => this.handleUnsupported(ctx));
  }

  private async whitelist(ctx: Context, next: NextFunction): Promise<void> {
    const userId = ctx.from?.id;
    if (userId === undefined || !this.deps.allowedUserIds.has(userId)) {
      this.logger.debug(`Update ignorado de usuário fora da whitelist (${userId ?? 'desconhecido'})`);
      return;
    }
    await next();
  }

  private async handleStart(ctx: Context): Promise<void> {
    await this.deps.output.notify(
      ctx.chat!.id,
      [
        `${(this.deps.identity ?? DEFAULT_IDENTITY).emoji} ${(this.deps.identity ?? DEFAULT_IDENTITY).name} online, rodando localmente.`,
        '',
        'Envie texto, PDF, arquivo .md ou áudio (voice note) que eu processo por aqui.',
        '',
        'Comandos:',
        '/nova — inicia uma nova conversa (arquiva o histórico atual)',
        '/skills — lista as skills instaladas',
        '/minhavoz — cadastra sua voz (envie um áudio de 10 a 30 s em seguida)',
        '/falar <texto> — devolve um áudio com a sua voz clonada',
        '/vozes — lista as vozes cadastradas',
      ].join('\n'),
    );
  }

  private async handleNewConversation(ctx: Context): Promise<void> {
    this.deps.controller.newConversation(ctx.from!.id);
    await this.deps.output.notify(ctx.chat!.id, '🆕 Nova conversa iniciada. O histórico anterior foi arquivado.');
  }

  private async handleListSkills(ctx: Context): Promise<void> {
    const skills = this.deps.controller.listSkills();
    const text = skills.length
      ? `📚 Skills instaladas (${skills.length}):\n\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}`
      : '📚 Nenhuma skill instalada em .agents/skills.';
    await this.deps.output.notify(ctx.chat!.id, text);
  }

  private handleText(ctx: Context): void {
    const text = ctx.message!.text!;
    const requiresAudioReply = AudioIntentDetector.resolve(text, false);
    const base = this.baseInput(ctx);
    this.dispatch(base.chatId, requiresAudioReply ? 'record_voice' : 'typing', async () => ({
      ...base,
      text,
      source: 'text',
      requiresAudioReply,
      ...(requiresAudioReply ? { voiceId: this.deps.voiceId } : {}),
    }));
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const document = ctx.message!.document!;
    const fileName = document.file_name ?? 'documento';
    const caption = ctx.message!.caption?.trim() ?? '';
    const base = this.baseInput(ctx);

    const extractor = this.deps.documents.find(fileName, document.mime_type);
    if (!extractor) {
      await this.deps.output.sendError(base.chatId, new UnsupportedAttachmentError(`${fileName} (${document.mime_type})`));
      return;
    }
    const maxBytes = Math.min(this.deps.maxDocumentBytes, TELEGRAM_DOWNLOAD_LIMIT);
    if (document.file_size && document.file_size > maxBytes) {
      await this.deps.output.sendError(base.chatId, new FileTooLargeError(`${fileName}: ${document.file_size} bytes`));
      return;
    }

    const requiresAudioReply = AudioIntentDetector.resolve(caption, false);
    this.dispatch(base.chatId, 'typing', async () => {
      const filePath = await this.deps.downloader.download(document.file_id, extractor.extension, maxBytes);
      let content: string;
      try {
        content = await extractor.extract(filePath);
      } catch (error) {
        throw new DocumentParseError(fileName, error);
      } finally {
        await this.deps.tmp.remove(filePath);
      }

      content = sanitizeText(content).trim() || '[Documento sem texto extraível]';
      content = truncate(content, this.deps.maxDocumentChars, '\n\n[... documento truncado por exceder o limite local ...]');
      this.logger.info(`📄 Documento "${fileName}" extraído (${content.length} chars)`);

      return {
        ...base,
        text: `${caption || 'Analise o documento anexado.'}\n\n[Documento anexado: ${fileName}]\n${content}`,
        source: 'document',
        requiresAudioReply,
        attachmentName: fileName,
        ...(requiresAudioReply ? { voiceId: this.deps.voiceId } : {}),
      };
    });
  }

  private handleAudio(ctx: Context): void {
    const message = ctx.message!;
    const media = message.voice ?? message.audio!;
    const caption = message.caption?.trim() ?? '';
    const extension = message.voice
      ? '.ogg'
      : AUDIO_EXTENSIONS[media.mime_type ?? ''] ?? (path.extname(message.audio?.file_name ?? '') || '.ogg');
    const base = this.baseInput(ctx);

    this.dispatch(base.chatId, 'record_voice', async () => {
      const filePath = await this.deps.downloader.download(media.file_id, extension, TELEGRAM_DOWNLOAD_LIMIT);
      let transcript: string;
      try {
        transcript = await this.deps.stt.transcribe(filePath);
      } finally {
        await this.deps.tmp.remove(filePath);
      }

      // EC-03: áudio mudo não polui o AgentLoop.
      if (!transcript) throw new EmptyAudioError();

      const text = caption ? `${caption}\n\n${transcript}` : transcript;
      const requiresAudioReply = AudioIntentDetector.resolve(text, true);
      return {
        ...base,
        text,
        source: 'voice',
        requiresAudioReply,
        ...(requiresAudioReply ? { voiceId: this.deps.voiceId } : {}),
      };
    });
  }

  private async handleUnsupported(ctx: Context): Promise<void> {
    await this.deps.output.sendError(ctx.chat!.id, new UnsupportedAttachmentError('tipo de mensagem não suportado'));
  }

  private baseInput(ctx: Context): Pick<AgentInput, 'userId' | 'chatId'> {
    return { userId: ctx.from!.id, chatId: ctx.chat!.id };
  }

  /**
   * Enfileira o processamento e retorna imediatamente, liberando o polling.
   * O indicador de digitação/gravação fica ativo durante toda a pipeline.
   */
  private dispatch(chatId: number, action: ChatAction, buildInput: () => Promise<AgentInput>): void {
    void this.deps.queue.enqueue(chatId, async () => {
      const stopAction = this.deps.notifier.start(chatId, action);
      try {
        const input = await buildInput();
        await this.deps.controller.handle(input);
      } catch (error) {
        this.logger.warn(`Entrada não processada: ${error instanceof Error ? error.message : String(error)}`);
        await this.deps.output.sendError(chatId, error);
      } finally {
        stopAction();
      }
    });
  }
}
