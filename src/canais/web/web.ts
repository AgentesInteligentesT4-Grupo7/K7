import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../../app/createCore.js';
import { ConfigError } from '../../config/Config.js';
import { DatabaseConnection } from '../../memory/DatabaseConnection.js';
import { loadConfig } from '../../profiles/ProfileLoader.js';
import { ProfileError } from '../../profiles/ProfileManifest.js';
import { Logger } from '../../utils/Logger.js';
import { WebChannel } from './WebChannel.js';

/**
 * Canal web avulso: `npm run web` (opções: --perfil <nome>, --abrir, --porta <n>).
 * Usa o mesmo núcleo do bot e pode rodar ao mesmo tempo que ele (como o terminal).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--porta');
  const config = loadConfig({ requireTelegram: false });
  Logger.setLevel(config.logLevel);

  const core = createCore(config, {
    // Pasta temporária própria: o bot limpa ./tmp ao reiniciar.
    tmpDir: path.join(os.tmpdir(), config.profileName ? `parreiraclaw-web-${config.profileName}` : 'parreiraclaw-web'),
    cleanTmp: true,
    databaseMaintenance: false,
    healthChecks: true,
  });
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) || config.web.port : config.web.port;
  const channel = new WebChannel(core, { ...config.web, port });
  await core.orchestrator?.provider.refresh();
  await channel.start();
  process.stdout.write(`\n${config.identity.emoji} ${config.identity.name} no navegador: ${channel.url}\n\n`);
  if (args.includes('--abrir')) openBrowser(channel.url);

  const shutdown = async (): Promise<void> => {
    await channel.stop();
    DatabaseConnection.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

function openBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${url}"`]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(command as string, commandArgs as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

main().catch((error: unknown) => {
  if (error instanceof ProfileError) process.stderr.write(`Perfil: ${error.message}\n`);
  else if (error instanceof ConfigError) process.stderr.write(`Configuração inválida: ${error.message}\n`);
  else if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') process.stderr.write('Porta em uso: rode com --porta <outra> ou defina WEB_PORT.\n');
  else process.stderr.write(`Falha fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  DatabaseConnection.close();
  process.exit(1);
});
