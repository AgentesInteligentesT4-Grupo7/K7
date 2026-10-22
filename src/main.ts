import { GrammyError } from 'grammy';
import { createCore } from './app/createCore.js';
import { createTelegramChannel } from './canais/telegram/TelegramChannel.js';
import { WebChannel } from './canais/web/WebChannel.js';
import { ConfigError } from './config/Config.js';
import { DatabaseConnection } from './memory/DatabaseConnection.js';
import { loadConfig } from './profiles/ProfileLoader.js';
import { ProfileError } from './profiles/ProfileManifest.js';
import { Logger } from './utils/Logger.js';

const logger = new Logger('Main');

/** Canal que roda como serviço (o terminal é interativo e tem a própria entrada: `npm run chat`). */
interface ServiceChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Composition root do tocador: núcleo compartilhado + canais de serviço ligados em CHANNELS. */
async function bootstrap(): Promise<void> {
  // Sem --perfil (ou PERFIL/PERFIL_PADRAO), usa só o .env raiz, como antes.
  const config = loadConfig();
  Logger.setLevel(config.logLevel);
  logger.info(`${config.identity.emoji} Iniciando ${config.identity.name}...`);

  const services: ServiceChannel[] = [];
  const core = createCore(config, { tmpDir: config.tmpDir, cleanTmp: true, databaseMaintenance: true, healthChecks: true });
  if (config.channels.has('telegram')) services.push(createTelegramChannel(core));
  if (config.channels.has('web')) services.push(new WebChannel(core, config.web));

  if (services.length === 0) {
    logger.error(`Nenhum canal de serviço ligado (CHANNELS=${[...config.channels].join(',')}). Use "npm run chat" para o terminal.`);
    DatabaseConnection.close();
    process.exit(1);
  }
  registerShutdown(services);
  await Promise.all(services.map((s) => s.start()));
}

function registerShutdown(services: ServiceChannel[]): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Recebido ${signal}, encerrando...`);
    await Promise.all(services.map((s) => s.stop().catch(() => undefined)));
    DatabaseConnection.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => logger.error('Promise rejeitada sem tratamento', reason));

bootstrap().catch((error: unknown) => {
  if (error instanceof ProfileError) {
    logger.error(`Perfil: ${error.message}`);
  } else if (error instanceof ConfigError) {
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
