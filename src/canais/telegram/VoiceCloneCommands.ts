import fs from 'node:fs';
import path from 'node:path';
import type { Bot, Context, NextFunction } from 'grammy';
import type { Message } from 'grammy/types';
import { errorMessage } from '../../errors/AppErrors.js';
import type { ChatQueue } from '../../utils/ChatQueue.js';
import { Logger } from '../../utils/Logger.js';
import type { TempFileManager } from '../../utils/TempFileManager.js';
import type { VoiceCloneService } from '../../voice/VoiceCloneService.js';
import { VoiceLibrary } from '../../voice/VoiceLibrary.js';
import type { VoiceTuner } from '../../voice/VoiceTuner.js';
import type { EnrollmentVerifier } from '../../voice/EnrollmentVerifier.js';
import type { ISpeechToText } from '../../voice/stt/WhisperTranscriber.js';
import type { ChatActionNotifier } from './ChatActionNotifier.js';
import type { TelegramFileDownloader } from './input/TelegramFileDownloader.js';
import type { TelegramOutputHandler } from './output/TelegramOutputHandler.js';
import { DIRECTION_HELP } from '../../voice/SpeechDirection.js';

export interface VoiceCloneCommandsDeps {
  service: VoiceCloneService;
  downloader: TelegramFileDownloader;
  output: TelegramOutputHandler;
  queue: ChatQueue;
  notifier: ChatActionNotifier;
  tmp: TempFileManager;
  defaultVoiceName: string;
  /** Teste e ajuste da voz (/testarvoz, /ajustar, /salvarvoz); ausente sem o módulo voz (sem transcrição). */
  tuner?: VoiceTuner;
  /**
   * Cadastro com texto para ler (VOICE_CLONE_VERIFY_TEXT): o áudio só vira voz se a transcrição bater com o
   * texto sorteado. Ausente = cadastro livre, como antes.
   */
  verification?: { verifier: EnrollmentVerifier; stt: ISpeechToText };
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;
/** Arquivo de áudio anexado (não gravado na hora): WhatsApp (.opus), gravadores, músicas. */
export const AUDIO_FILE = /\.(ogg|oga|opus|mp3|wav|m4a|aac|flac|webm|amr)$/i;

export function isAudioDocument(document: { file_name?: string; mime_type?: string } | undefined): boolean {
  return Boolean(document && (AUDIO_FILE.test(document.file_name ?? '') || document.mime_type?.startsWith('audio/')));
}

/** Áudio gravado (voice), enviado como música (audio) ou anexado como arquivo (document). */
export function audioMedia(message: Message): { fileId: string; extension: string } | undefined {
  if (message.voice) return { fileId: message.voice.file_id, extension: '.ogg' };
  const file = message.audio ?? (isAudioDocument(message.document) ? message.document : undefined);
  if (!file) return undefined;
  const fromName = path.extname(file.file_name ?? '').toLowerCase();
  const fromMime = file.mime_type === 'audio/mpeg' ? '.mp3' : file.mime_type === 'audio/wav' || file.mime_type === 'audio/x-wav' ? '.wav' : '.ogg';
  return { fileId: file.file_id, extension: fromName || fromMime };
}

type Pending = { kind: 'cadastro'; name: string; expiresAt: number; text?: string } | { kind: 'teste'; voice?: string; expiresAt: number };

/**
 * Comandos de clonagem de voz (o áudio pode ser gravado na hora ou anexado como arquivo):
 *   /minhavoz [nome] — o próximo áudio vira a amostra da voz (salva em VOICE_CLONE_DIR)
 *   /falar [@voz] texto — devolve um voice note com a voz clonada falando exatamente o texto
 *                          (marcações como "(rápido)" e "(pausa)" mudam o jeito de falar; ver SpeechDirection)
 *   /testarvoz [@voz] — o próximo áudio é transcrito e falado de novo (pela própria amostra ou pela voz)
 *   /ajustar <pedido> — refaz o último teste ou /falar ("mais emoção", "mais lento", "igualar"...)
 *   /salvarvoz [nome] — guarda o resultado ajustado
 *   /vozes — lista as vozes da pasta;  /apagarvoz nome — apaga uma
 *   /cancelar — cancela o cadastro ou teste pendente
 */
export class VoiceCloneCommands {
  private readonly logger = new Logger('VoiceClone');
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly deps: VoiceCloneCommandsDeps) {}

  register(bot: Bot): void {
    bot.command('minhavoz', (ctx) => this.handleEnroll(ctx));
    bot.command('falar', (ctx) => this.handleSpeak(ctx));
    bot.command('testarvoz', (ctx) => this.handleTest(ctx));
    bot.command('ajustar', (ctx) => this.handleAdjust(ctx));
    bot.command('salvarvoz', (ctx) => this.handleSave(ctx));
    bot.command('vozes', (ctx) => this.handleList(ctx));
    bot.command('apagarvoz', (ctx) => this.handleRemove(ctx));
    bot.command('cancelar', (ctx) => this.handleCancel(ctx));
    bot.on(['message:voice', 'message:audio', 'message:document'], (ctx, next) => this.captureAudio(ctx, next));
  }

  private async handleEnroll(ctx: Context): Promise<void> {
    const name = VoiceLibrary.sanitizeName(String(ctx.match ?? '').trim() || this.deps.defaultVoiceName);
    let text: string | undefined;
    if (this.deps.verification) {
      const stopAction = this.deps.notifier.start(ctx.chat!.id, 'typing');
      try {
        text = await this.deps.verification.verifier.challenge(String(ctx.from?.id ?? ctx.chat!.id));
      } catch (error) {
        await this.deps.output.sendError(ctx.chat!.id, error);
        return;
      } finally {
        stopAction();
      }
    }
    this.pending.set(ctx.chat!.id, { kind: 'cadastro', name, expiresAt: Date.now() + PENDING_TTL_MS, ...(text ? { text } : {}) });
    const instructions = text
      ? [
          'Grave um áudio lendo em voz alta, com calma, o texto abaixo (sem música nem barulho de fundo):',
          '',
          `«${text}»`,
          '',
          'O texto é sorteado agora, para garantir que a voz é de quem está gravando. Não precisa ser perfeito.',
        ]
      : [
          'Grave agora um áudio de 10 a 25 segundos falando naturalmente, sem música nem barulho de fundo,',
          'ou anexe um arquivo de áudio (.opus do WhatsApp, .mp3, .wav, .ogg).',
        ];
    await this.deps.output.notify(ctx.chat!.id, [`🎙️ Pronto para gravar a voz "${name}".`, '', ...instructions, '', 'Para cancelar: /cancelar'].join('\n'));
  }

  private async handleTest(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    if (!this.deps.tuner) {
      await this.deps.output.notify(chatId, '⚠️ O teste de voz precisa do módulo "voz" (transcrição) ligado.');
      return;
    }
    const raw = String(ctx.match ?? '').trim().replace(/^@/, '');
    let voice: string | undefined;
    try {
      voice = raw ? this.deps.service.resolveName(raw) : undefined;
    } catch (error) {
      await this.deps.output.sendError(chatId, error);
      return;
    }
    this.pending.set(chatId, { kind: 'teste', ...(voice ? { voice } : {}), expiresAt: Date.now() + PENDING_TTL_MS });
    await this.deps.output.notify(
      chatId,
      [
        voice
          ? `🧪 Teste com a voz "${voice}": grave ou anexe um áudio de alguém falando. Eu transcrevo e falo o mesmo texto com a voz "${voice}", para comparar ritmo e duração com o original.`
          : '🧪 Teste espelho: grave ou anexe um áudio de alguém falando. Eu uso esse áudio como amostra, transcrevo e falo o mesmo texto de novo, para você comparar.',
        '',
        'Depois dá para refinar com /ajustar e guardar com /salvarvoz. Para cancelar: /cancelar',
      ].join('\n'),
    );
  }

  private async handleAdjust(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const request = String(ctx.match ?? '').trim();
    const { tuner } = this.deps;
    if (!tuner) {
      await this.deps.output.notify(chatId, '⚠️ O ajuste de voz precisa do módulo "voz" ligado.');
      return;
    }
    void this.deps.queue.enqueue(chatId, async () => {
      const stopAction = this.deps.notifier.start(chatId, 'record_voice');
      try {
        const { audio, report } = await tuner.adjust(String(chatId), request);
        await this.deps.output.sendPreparedVoice(chatId, 'ajuste', audio);
        await this.deps.output.notify(chatId, report);
      } catch (error) {
        await this.deps.output.sendError(chatId, error);
      } finally {
        stopAction();
      }
    });
  }

  private async handleSave(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    try {
      if (!this.deps.tuner) throw new Error('teste de voz indisponível');
      await this.deps.output.notify(chatId, this.deps.tuner.save(String(chatId), String(ctx.match ?? '').trim().replace(/^@/, '') || undefined));
    } catch (error) {
      await this.deps.output.sendError(chatId, error);
    }
  }

  private async handleSpeak(ctx: Context): Promise<void> {
    const raw = String(ctx.match ?? '').trim();
    const match = /^@(\S+)\s+([\s\S]+)$/.exec(raw);
    const voice = match ? match[1] : undefined;
    const text = (match ? match[2]! : raw).trim();
    if (!text) {
      await this.deps.output.notify(ctx.chat!.id, `Uso: /falar <texto>  ou  /falar @nome-da-voz <texto>\n\n${DIRECTION_HELP}`);
      return;
    }
    const chatId = ctx.chat!.id;
    try {
      this.deps.tuner?.remember(String(chatId), text, voice);
    } catch {
      // Voz inexistente: o /falar abaixo responde com o erro amigável.
    }
    void this.deps.queue.enqueue(chatId, () => this.deps.output.sendClonedVoice(chatId, text, voice));
  }

  private async handleList(ctx: Context): Promise<void> {
    const voices = this.deps.service.list();
    const dir = this.deps.service.voicesDir;
    const text = voices.length
      ? `🗣️ Vozes cadastradas (${voices.length}):\n\n${voices.map((voice) => `- ${voice.name} (${path.basename(voice.filePath)})`).join('\n')}\n\nPasta: ${dir}\nUse: /falar @nome texto\nTestar: /testarvoz @nome · Apagar: /apagarvoz nome`
      : `🗣️ Nenhuma voz cadastrada.\n\nUse /minhavoz e envie um áudio, ou coloque arquivos .wav/.mp3/.ogg em:\n${dir}`;
    await this.deps.output.notify(ctx.chat!.id, text);
  }

  private async handleRemove(ctx: Context): Promise<void> {
    const name = String(ctx.match ?? '').trim().replace(/^@/, '');
    const chatId = ctx.chat!.id;
    if (!name) {
      const voices = this.deps.service.list().map((v) => v.name);
      await this.deps.output.notify(chatId, `Uso: /apagarvoz <nome>${voices.length ? `\nVozes: ${voices.join(', ')}` : ''}`);
      return;
    }
    try {
      const message = this.deps.service.remove(name);
      this.logger.info(`🗑️ Voz "${name}" apagada`);
      await this.deps.output.notify(chatId, message);
    } catch (error) {
      await this.deps.output.sendError(chatId, error);
    }
  }

  private async handleCancel(ctx: Context): Promise<void> {
    const pending = this.pending.get(ctx.chat!.id);
    this.pending.delete(ctx.chat!.id);
    await this.deps.output.notify(ctx.chat!.id, pending ? `${pending.kind === 'teste' ? 'Teste' : 'Cadastro'} de voz cancelado.` : 'Nenhum cadastro ou teste de voz pendente.');
  }

  /** Com cadastro ou teste pendente, o áudio (gravado ou anexado) vai para ele; senão segue o fluxo normal. */
  private async captureAudio(ctx: Context, next: NextFunction): Promise<void> {
    const chatId = ctx.chat!.id;
    const pending = this.pending.get(chatId);
    if (!pending || pending.expiresAt < Date.now()) {
      if (pending) this.pending.delete(chatId);
      return next();
    }
    const media = audioMedia(ctx.message!);
    if (!media) return next();

    void this.deps.queue.enqueue(chatId, async () => {
      const stopAction = this.deps.notifier.start(chatId, pending.kind === 'teste' ? 'record_voice' : 'typing');
      let tmpPath: string | undefined;
      try {
        tmpPath = await this.deps.downloader.download(media.fileId, media.extension, MAX_SAMPLE_BYTES);
        if (pending.kind === 'teste') await this.runTest(chatId, tmpPath, media.extension, pending.voice);
        else {
          // Com verificação: só cadastra se a leitura bater com o texto sorteado (o pendente fica para regravar).
          if (pending.text && !(await this.verifyReading(chatId, pending.text, tmpPath))) return;
          await this.enroll(chatId, pending.name, tmpPath, media.extension);
        }
        this.pending.delete(chatId);
      } catch (error) {
        this.logger.warn(`Falha no ${pending.kind} de voz: ${errorMessage(error)}`);
        await this.deps.output.sendError(chatId, error);
        await this.deps.output.notify(chatId, 'Envie outro áudio para tentar de novo, ou /cancelar.');
      } finally {
        stopAction();
        await this.deps.tmp.remove(tmpPath);
      }
    });
  }

  /** Transcreve e compara com o texto pedido; reprovado, explica e mantém o cadastro aberto para regravar. */
  private async verifyReading(chatId: number, expected: string, filePath: string): Promise<boolean> {
    const { verifier, stt } = this.deps.verification!;
    const transcript = (await stt.transcribe(filePath)).trim();
    const { ok, match } = verifier.check(expected, transcript);
    const percent = Math.round(match * 100);
    this.logger.info(`🔐 Cadastro de voz: ${percent}% do texto lido (${ok ? 'aprovado' : 'reprovado'})`);
    if (ok) return true;
    await this.deps.output.notify(
      chatId,
      [
        `❌ O áudio não corresponde ao texto pedido (só ${percent}% do texto foi reconhecido).`,
        transcript ? `Ouvi: "${transcript.slice(0, 200)}"` : 'Não entendi fala no áudio.',
        '',
        `Grave de novo lendo: «${expected}»`,
        'Ou /cancelar.',
      ].join('\n'),
    );
    return false;
  }

  private async enroll(chatId: number, name: string, filePath: string, extension: string): Promise<void> {
    const { sample, durationSeconds, trimmedFromSeconds } = await this.deps.service.enroll(name, fs.readFileSync(filePath), extension);
    const duration = trimmedFromSeconds
      ? ` (usei os primeiros ${durationSeconds!.toFixed(0)}s dos ${trimmedFromSeconds.toFixed(1)}s: o limite da clonagem é 30s)`
      : durationSeconds !== null
        ? ` (${durationSeconds.toFixed(1)}s)`
        : '';
    this.logger.info(`💾 Voz "${sample.name}" cadastrada${duration} em ${sample.filePath}`);
    await this.deps.output.notify(
      chatId,
      `✅ Voz "${sample.name}" salva${duration}.\n\nAgora é só digitar: /falar <texto>\nOu peça normalmente: "manda isso com a minha voz: ..."\nPara conferir: /testarvoz @${sample.name}`,
    );
  }

  private async runTest(chatId: number, filePath: string, extension: string, voice?: string): Promise<void> {
    const { audio, report } = await this.deps.tuner!.test(String(chatId), filePath, extension, voice);
    await this.deps.output.sendPreparedVoice(chatId, 'teste', audio);
    await this.deps.output.notify(chatId, report);
  }
}
