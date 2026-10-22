import fs from 'node:fs';
import path from 'node:path';
import type { Bot, Context, NextFunction } from 'grammy';
import type { AgentController } from '../../agent/AgentController.js';
import { FileTooLargeError } from '../../errors/AppErrors.js';
import { AttachmentService, type IngestedAttachment } from '../../modules/anexos/AttachmentService.js';
import type { ChatQueue } from '../../utils/ChatQueue.js';
import { Logger } from '../../utils/Logger.js';
import type { TempFileManager } from '../../utils/TempFileManager.js';
import { AudioIntentDetector } from '../../voice/AudioIntentDetector.js';
import type { ChatActionNotifier } from './ChatActionNotifier.js';
import type { TelegramFileDownloader } from './input/TelegramFileDownloader.js';
import type { TelegramOutputHandler } from './output/TelegramOutputHandler.js';

export interface AttachmentHandlerDeps {
  attachments: AttachmentService;
  controller: AgentController;
  output: TelegramOutputHandler;
  downloader: TelegramFileDownloader;
  tmp: TempFileManager;
  queue: ChatQueue;
  notifier: ChatActionNotifier;
  maxBytes: number;
  voiceId: string;
  /** Janela para juntar as fotos de um álbum numa só mensagem (spec attachments RF-01). */
  albumWindowMs?: number;
}

interface PendingFile {
  fileId: string;
  name: string;
  mime: string;
  size?: number;
}

interface Album {
  chatId: number;
  userId: number;
  caption: string;
  files: PendingFile[];
  timer: NodeJS.Timeout;
}

/** Limite de download da Bot API do Telegram. */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/**
 * Anexos no Telegram (módulo anexos): fotos, álbuns, imagens e documentos enviados como arquivo
 * vão para a biblioteca e chegam ao agente como referência + trecho (+ imagem para visão).
 * O que não for suportado segue para o fluxo antigo (`next`).
 */
export class TelegramAttachmentHandler {
  private readonly logger = new Logger('Anexos');
  private readonly albums = new Map<string, Album>();

  constructor(private readonly deps: AttachmentHandlerDeps) {}

  register(bot: Bot): void {
    bot.command('anexos', (ctx) => this.handleList(ctx));
    bot.command('apagar_anexo', (ctx) => this.handleRemove(ctx));
    bot.on('message:photo', (ctx) => {
      const photo = ctx.message.photo.at(-1)!;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      this.accept(ctx, { fileId: photo.file_id, name: `foto-${stamp}.jpg`, mime: 'image/jpeg', size: photo.file_size });
    });
    bot.on('message:document', (ctx, next) => this.handleDocument(ctx, next));
  }

  private async handleDocument(ctx: Context, next: NextFunction): Promise<void> {
    const document = ctx.message!.document!;
    const name = document.file_name ?? 'documento';
    if (!AttachmentService.supports(name, document.mime_type)) return next();
    this.accept(ctx, { fileId: document.file_id, name, mime: document.mime_type ?? '', size: document.file_size });
  }

  /** Arquivo avulso vai direto; parte de álbum espera as demais por alguns instantes. */
  private accept(ctx: Context, file: PendingFile): void {
    const message = ctx.message!;
    const chatId = ctx.chat!.id;
    const userId = ctx.from!.id;
    const maxBytes = Math.min(this.deps.maxBytes, TELEGRAM_DOWNLOAD_LIMIT);
    if (file.size && file.size > maxBytes) {
      void this.deps.output.sendError(chatId, new FileTooLargeError(`${file.name}: ${file.size} bytes`));
      return;
    }
    const caption = message.caption?.trim() ?? '';
    const group = message.media_group_id;
    if (!group) return this.dispatch(chatId, userId, caption, [file]);

    const album = this.albums.get(group);
    if (album) {
      clearTimeout(album.timer);
      album.files.push(file);
      if (caption) album.caption = caption;
    } else {
      this.albums.set(group, { chatId, userId, caption, files: [file], timer: undefined as unknown as NodeJS.Timeout });
    }
    const current = this.albums.get(group)!;
    current.timer = setTimeout(() => {
      this.albums.delete(group);
      this.dispatch(current.chatId, current.userId, current.caption, current.files);
    }, this.deps.albumWindowMs ?? 1500);
  }

  private dispatch(chatId: number, userId: number, caption: string, files: PendingFile[]): void {
    void this.deps.queue.enqueue(chatId, async () => {
      const stop = this.deps.notifier.start(chatId, 'typing');
      try {
        const items: IngestedAttachment[] = [];
        for (const file of files) items.push(await this.ingest(userId, file, caption));
        const built = this.deps.attachments.buildInput(items, caption);
        const requiresAudioReply = AudioIntentDetector.resolve(caption, false);
        await this.deps.controller.handle({
          userId,
          chatId,
          text: built.text,
          source: built.images.length ? 'image' : 'document',
          attachmentName: built.attachmentName,
          ...(built.images.length ? { images: built.images } : {}),
          requiresAudioReply,
          ...(requiresAudioReply ? { voiceId: this.deps.voiceId } : {}),
        });
      } catch (error) {
        this.logger.warn(`Anexo não processado: ${error instanceof Error ? error.message : String(error)}`);
        await this.deps.output.sendError(chatId, error);
      } finally {
        stop();
      }
    });
  }

  private async ingest(userId: number, file: PendingFile, caption: string): Promise<IngestedAttachment> {
    const extension = path.extname(file.name) || '.bin';
    const local = await this.deps.downloader.download(file.fileId, extension, Math.min(this.deps.maxBytes, TELEGRAM_DOWNLOAD_LIMIT));
    try {
      const data = await fs.promises.readFile(local);
      return await this.deps.attachments.ingest({ userId: String(userId), name: file.name, mime: file.mime, data, caption });
    } finally {
      await this.deps.tmp.remove(local);
    }
  }

  private async handleList(ctx: Context): Promise<void> {
    const items = this.deps.attachments.store.list(String(ctx.from!.id), { limit: 20 });
    const text = items.length
      ? `📎 Seus anexos (${items.length} mais recentes):\n\n${items.map((a) => `#${a.id} · ${a.name} · ${a.kind} · ${a.createdAt.slice(0, 16)}`).join('\n')}\n\nApagar: /apagar_anexo <id>`
      : '📎 Nenhum anexo guardado ainda. Envie uma imagem, PDF ou arquivo de texto.';
    await this.deps.output.notify(ctx.chat!.id, text);
  }

  private async handleRemove(ctx: Context): Promise<void> {
    const id = Number(String(ctx.match ?? '').trim().replace(/^#/, ''));
    const ok = Number.isInteger(id) && this.deps.attachments.store.remove(String(ctx.from!.id), id);
    await this.deps.output.notify(ctx.chat!.id, ok ? `🗑️ Anexo #${id} apagado.` : 'Use: /apagar_anexo <id> (veja os IDs em /anexos).');
  }
}
