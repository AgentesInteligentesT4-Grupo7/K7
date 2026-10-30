import 'dotenv/config';
import { spawn } from 'node:child_process';
import { Logger } from '../../utils/Logger.js';
import { AdminServer } from './AdminServer.js';
import { FitaRunner } from './FitaRunner.js';

/**
 * Administração das fitas: `npm run admin` (opções: --abrir, --porta <n>). Só no próprio computador (127.0.0.1).
 * ADMIN_PORT (padrão 8770), ADMIN_TOKEN (fixo; vazio gera um a cada início) e ADMIN_FITA_PORTA_BASE (padrão 8810:
 * portas do chat web das fitas ligadas pela página).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--porta');
  Logger.setLevel((process.env.LOG_LEVEL as never) || 'info');
  const rootDir = process.cwd();
  const server = new AdminServer({
    port: portIndex >= 0 ? Number(args[portIndex + 1]) || 8770 : positive(process.env.ADMIN_PORT, 8770),
    rootDir,
    env: process.env,
    ...(process.env.ADMIN_TOKEN?.trim() ? { token: process.env.ADMIN_TOKEN.trim() } : {}),
    runner: new FitaRunner({ rootDir, webPortBase: positive(process.env.ADMIN_FITA_PORTA_BASE, 8810) }),
  });
  await server.start();
  process.stdout.write(`\n📼 Administração das fitas (só neste computador): ${server.url}\n\n`);
  if (args.includes('--abrir')) openBrowser(server.url);

  const shutdown = async (): Promise<void> => {
    process.stdout.write('\nDesligando as fitas ligadas pela página…\n');
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function openBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${url}"`]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(command as string, commandArgs as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

main().catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') process.stderr.write('Porta em uso: rode com --porta <outra> ou defina ADMIN_PORT.\n');
  else process.stderr.write(`Falha: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
