import { type Api, type Bot, type Context, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { errorMessage } from '../errors/AppErrors.js';
import type { Logger } from '../utils/Logger.js';
import type { BotCommand } from '../canais/telegram/botCommands.js';
import type { FitaTelegramApi, TelegramCtx, TelegramResposta } from './FitaApi.js';

type CommandHandler = Parameters<FitaTelegramApi['comando']>[2];
type LocationHandler = Parameters<FitaTelegramApi['aoLocalizacao']>[0];
type ButtonHandler = Parameters<FitaTelegramApi['botoes']>[1];

/**
 * O que a extensão da fita registra no bot do Telegram (comandos, localização, botões) e o envio de mensagens fora
 * de uma resposta. O canal Telegram liga isto ao bot (depois do controle de acesso); sem o canal, `notificar` avisa
 * que está desligado.
 */
export class ExtensionTelegram {
  private readonly commands: Array<{ nome: string; descricao: string; run: CommandHandler }> = [];
  private readonly locations: LocationHandler[] = [];
  private readonly buttons: Array<{ prefixo: string; run: ButtonHandler }> = [];
  private api?: Api;

  constructor(private readonly logger: Logger) {}

  /** Comandos da fita para o menu do bot. */
  menu(): BotCommand[] {
    return this.commands.filter((c) => c.nome !== 'start').map((c) => ({ command: c.nome, description: c.descricao.slice(0, 256) }));
  }

  get attached(): boolean {
    return this.api !== undefined;
  }

  attach(api: Api): void {
    this.api = api;
  }

  /** @ do bot (para os links de convite). */
  async botUsername(): Promise<string> {
    if (!this.api) throw Object.assign(new Error('canal Telegram desligado'), { userMessage: 'O bot do Telegram desta fita não está ligado neste processo.' });
    this.username ??= (await this.api.getMe()).username;
    return this.username;
  }

  private username?: string;

  addCommand(nome: string, descricao: string, run: CommandHandler): void {
    if (!/^[a-z0-9_]{1,32}$/.test(nome)) throw new Error(`Comando do Telegram inválido: "${nome}" (minúsculas, números e _, até 32)`);
    this.commands.push({ nome, descricao, run });
  }

  addLocation(run: LocationHandler): void {
    this.locations.push(run);
  }

  addButtons(prefixo: string, run: ButtonHandler): void {
    if (!/^[a-z0-9_-]{1,20}$/.test(prefixo)) throw new Error(`Prefixo de botões inválido: "${prefixo}"`);
    this.buttons.push({ prefixo, run });
  }

  async notify(userId: string, message: string | TelegramResposta): Promise<{ entregue: boolean; erro?: string }> {
    if (!this.api) return { entregue: false, erro: 'canal Telegram desligado neste processo' };
    const chatId = Number(userId);
    if (!Number.isSafeInteger(chatId)) return { entregue: false, erro: `usuário inválido: ${userId}` };
    try {
      await send(this.api, chatId, message);
      return { entregue: true };
    } catch (error) {
      return { entregue: false, erro: (error as { description?: string }).description ?? errorMessage(error) };
    }
  }

  /** Liga os handlers ao bot (chamado pelo canal Telegram, logo depois do controle de acesso). */
  register(bot: Bot): void {
    for (const command of this.commands) {
      bot.command(command.nome, (ctx) => this.safe(ctx, () => command.run({ ...this.ctx(ctx), args: String(ctx.match ?? '').trim() })));
    }
    if (this.locations.length) {
      bot.on('message:location', (ctx) =>
        this.safe(ctx, async () => {
          const { latitude, longitude } = ctx.message.location;
          for (const run of this.locations) await run({ ...this.ctx(ctx), lat: latitude, lon: longitude });
        }),
      );
    }
    for (const { prefixo, run } of this.buttons) {
      bot.callbackQuery(new RegExp(`^${prefixo}:`), (ctx) =>
        this.safe(ctx, async () => {
          await ctx.answerCallbackQuery().catch(() => undefined);
          await run({
            ...this.ctx(ctx),
            dados: ctx.callbackQuery.data,
            editar: async (resposta) => {
              // Foto não troca o texto de uma mensagem: vai como nova.
              if (typeof resposta !== 'string' && resposta.imagem) return send(ctx.api, ctx.chat?.id ?? ctx.from.id, resposta);
              const { text, extra } = toTelegram(resposta);
              await ctx.editMessageText(text, extra.reply_markup instanceof InlineKeyboard ? { reply_markup: extra.reply_markup } : {}).catch(() => ctx.reply(text, extra));
            },
          });
        }),
      );
    }
  }

  private ctx(ctx: Context): TelegramCtx {
    const from = ctx.from!;
    return {
      userId: String(from.id),
      chatId: ctx.chat?.id ?? from.id,
      nome: [from.first_name, from.last_name].filter(Boolean).join(' '),
      responder: async (resposta) => send(ctx.api, ctx.chat?.id ?? from.id, resposta),
    };
  }

  /** Erro da fita: a pessoa vê a mensagem amigável (userMessage) ou um aviso genérico; o detalhe vai para o log. */
  private async safe(ctx: Context, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(`Erro na extensão (Telegram): ${errorMessage(error)}`, error);
      const friendly = (error as { userMessage?: unknown }).userMessage;
      await ctx.reply(typeof friendly === 'string' ? `⚠️ ${friendly}` : '⚠️ Não consegui fazer isso agora; tente de novo daqui a pouco.').catch(() => undefined);
    }
  }
}

function toTelegram(message: string | TelegramResposta): { text: string; extra: { reply_markup?: InlineKeyboard | Keyboard | { remove_keyboard: true } } } {
  const r = typeof message === 'string' ? { texto: message } : message;
  if (r.pedirLocalizacao) return { text: r.texto, extra: { reply_markup: new Keyboard().requestLocation(r.pedirLocalizacao).resized().oneTime() } };
  if (r.botoes?.length) {
    const keyboard = new InlineKeyboard();
    r.botoes.forEach((row, i) => {
      if (i > 0) keyboard.row();
      for (const b of row) keyboard.text(b.texto, b.dados);
    });
    return { text: r.texto, extra: { reply_markup: keyboard } };
  }
  return { text: r.texto, extra: {} };
}

/** Texto, ou foto com legenda (legenda acima do limite do Telegram vai numa mensagem logo depois). */
async function send(api: Api, chatId: number, message: string | TelegramResposta): Promise<void> {
  const { text, extra } = toTelegram(message);
  const image = typeof message === 'string' ? undefined : message.imagem;
  if (!image) return void (await api.sendMessage(chatId, text, extra));
  const photo = new InputFile(image, 'imagem.png');
  if (text.length <= 1024) return void (await api.sendPhoto(chatId, photo, { caption: text, ...extra }));
  await api.sendPhoto(chatId, photo);
  await api.sendMessage(chatId, text, extra);
}
