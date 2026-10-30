import { Bot, GrammyError, HttpError } from 'grammy';
import { Logger } from '../../utils/Logger.js';
import { type BotCommand, OWNER_COMMANDS } from './botCommands.js';

/** Ciclo de vida do bot grammy (long polling local). */
export class TelegramBotApp {
  private readonly logger = new Logger('Bot');

  constructor(
    readonly bot: Bot,
    /** Menu de comandos do bot (o que os módulos e a extensão da fita oferecem). */
    private readonly commands: BotCommand[] = [],
    /** Donos: recebem no menu também os comandos de acesso (/convite, /acessos). */
    private readonly owners: ReadonlySet<number> = new Set(),
  ) {
    bot.catch((err) => {
      const { error } = err;
      if (error instanceof GrammyError) this.logger.error(`Erro da Bot API: ${error.description}`);
      else if (error instanceof HttpError) this.logger.error(`Erro de rede com o Telegram: ${error.message}`);
      else this.logger.error('Erro não tratado em handler', error);
    });
  }

  /** Inicia o long polling. A Promise só resolve quando o bot é parado. */
  async start(): Promise<void> {
    await this.bot.api.setMyCommands(this.commands).catch(() => undefined);
    // Donos veem também os comandos de acesso (só no chat deles).
    for (const owner of this.owners) {
      await this.bot.api.setMyCommands([...OWNER_COMMANDS, ...this.commands], { scope: { type: 'chat', chat_id: owner } }).catch(() => undefined);
    }

    await this.bot.start({
      drop_pending_updates: false,
      // callback_query: botões (Aprovar/Recusar e os das fitas).
      allowed_updates: ['message', 'callback_query'],
      onStart: (info) => this.logger.info(`🤖 Bot @${info.username} ouvindo via long polling`),
    });
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }
}
