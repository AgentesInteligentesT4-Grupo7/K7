import { Bot, GrammyError, HttpError } from 'grammy';
import { Logger } from '../utils/Logger.js';

/** Ciclo de vida do bot grammy (long polling local). */
export class TelegramBotApp {
  private readonly logger = new Logger('Bot');

  constructor(readonly bot: Bot) {
    bot.catch((err) => {
      const { error } = err;
      if (error instanceof GrammyError) this.logger.error(`Erro da Bot API: ${error.description}`);
      else if (error instanceof HttpError) this.logger.error(`Erro de rede com o Telegram: ${error.message}`);
      else this.logger.error('Erro não tratado em handler', error);
    });
  }

  /** Inicia o long polling. A Promise só resolve quando o bot é parado. */
  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: 'nova', description: 'Iniciar nova conversa' },
      { command: 'falar', description: 'Gerar áudio com a sua voz clonada: /falar <texto>' },
      { command: 'minhavoz', description: 'Cadastrar sua voz (envie um áudio em seguida)' },
      { command: 'vozes', description: 'Listar vozes cadastradas' },
      { command: 'skills', description: 'Listar skills instaladas' },
      { command: 'modelos', description: 'Ranking dos modelos gratuitos (orquestrador)' },
      { command: 'modelo', description: 'Qual modelo respondeu a última mensagem' },
      { command: 'bom', description: 'A última resposta foi boa (feedback)' },
      { command: 'ruim', description: 'A última resposta foi ruim (feedback)' },
      { command: 'start', description: 'Ajuda' },
    ]).catch(() => undefined);

    await this.bot.start({
      drop_pending_updates: false,
      allowed_updates: ['message'],
      onStart: (info) => this.logger.info(`🤖 Bot @${info.username} ouvindo via long polling`),
    });
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }
}
