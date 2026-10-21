import { Bot, GrammyError } from 'grammy';
import { createCore } from './app/createCore.js';
import { TelegramBotApp } from './bot/TelegramBotApp.js';
import { Config, ConfigError } from './config/Config.js';
import { DatabaseConnection } from './memory/DatabaseConnection.js';
import { ChatActionNotifier } from './telegram/ChatActionNotifier.js';
import { TelegramFileDownloader } from './telegram/input/TelegramFileDownloader.js';
import { AudioOutputStrategy } from './telegram/output/strategies/AudioOutputStrategy.js';
import { ErrorOutputStrategy } from './telegram/output/strategies/ErrorOutputStrategy.js';
import { FileOutputStrategy } from './telegram/output/strategies/FileOutputStrategy.js';
import { TextOutputStrategy } from './telegram/output/strategies/TextOutputStrategy.js';
import { TelegramOutputHandler } from './telegram/output/TelegramOutputHandler.js';
import { TelegramSender } from './telegram/output/TelegramSender.js';
import { TelegramInputHandler } from './telegram/TelegramInputHandler.js';
import { VoiceCloneCommands } from './telegram/VoiceCloneCommands.js';
import { OrchestratorCommands } from './llm/orchestration/OrchestratorCommands.js';
import { ChatQueue } from './utils/ChatQueue.js';
import { Logger } from './utils/Logger.js';

const logger = new Logger('Main');

/** Composition root do canal Telegram: núcleo compartilhado + adaptadores de entrada/saída. */
async function bootstrap(): Promise<void> {
  const config = new Config();
  Logger.setLevel(config.logLevel);
  logger.info(`${config.identity.emoji} Iniciando ${config.identity.name}...`);

  const core = createCore(config, { tmpDir: config.tmpDir, cleanTmp: true, databaseMaintenance: true, healthChecks: true });

  // Telegram: saída
  const bot = new Bot(config.telegramBotToken);
  const sender = new TelegramSender(bot.api);
  const notifier = new ChatActionNotifier(sender);
  const textStrategy = new TextOutputStrategy(sender);
  const output = new TelegramOutputHandler(
    {
      text: textStrategy,
      file: new FileOutputStrategy(sender, core.tmp, textStrategy),
      error: new ErrorOutputStrategy(sender),
      audio: new AudioOutputStrategy(sender, core.tmp, core.tts, core.ffmpeg, notifier),
    },
    core.voiceClone,
  );
  const controller = core.createController(output);

  // Telegram: entrada
  const downloader = new TelegramFileDownloader(bot.api, config.telegramBotToken, core.tmp);
  const queue = new ChatQueue();
  const voiceCommands = new VoiceCloneCommands({
    service: core.voiceClone,
    downloader,
    output,
    queue,
    notifier,
    tmp: core.tmp,
    defaultVoiceName: config.voiceClone.defaultVoice ?? 'minha-voz',
  });
  new TelegramInputHandler({
    allowedUserIds: config.allowedUserIds,
    controller,
    output,
    downloader,
    documents: core.documents,
    stt: core.stt,
    tmp: core.tmp,
    queue,
    notifier,
    maxDocumentBytes: config.maxDocumentBytes,
    maxDocumentChars: config.maxDocumentChars,
    voiceId: core.tts.voice,
    extraCommands: [
      voiceCommands,
      ...(core.orchestrator
        ? [
            {
              register: (b: Bot) =>
                new OrchestratorCommands(core.orchestrator!, config.orchestrator.privacyDefault).register(b, (chatId, text) =>
                  output.notify(chatId, text),
                ),
            },
          ]
        : []),
    ],
    identity: config.identity,
  }).register(bot);

  const app = new TelegramBotApp(bot);
  registerShutdown(app);
  logger.info(`🔒 Whitelist: ${config.allowedUserIds.size} usuário(s) autorizado(s)`);
  await app.start();
}

function registerShutdown(app: TelegramBotApp): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Recebido ${signal}, encerrando...`);
    await app.stop().catch(() => undefined);
    DatabaseConnection.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => logger.error('Promise rejeitada sem tratamento', reason));

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logger.error(`Configuração inválida: ${error.message}`);
    logger.error('Copie .env.example para .env e preencha as variáveis.');
  } else if (error instanceof GrammyError && error.error_code === 401) {
    logger.error('TELEGRAM_BOT_TOKEN inválido (401 Unauthorized).');
  } else if (error instanceof GrammyError && error.error_code === 409) {
    logger.error('Outra instância do bot já está fazendo polling com este token (409 Conflict).');
  } else {
    logger.error('Falha fatal no startup', error);
  }
  DatabaseConnection.close();
  process.exit(1);
});
