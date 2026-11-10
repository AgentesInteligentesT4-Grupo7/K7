import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Logger } from '../../utils/Logger.js';
import { AcessoCloudflare, PessoasDaAdmin } from './AdminPessoas.js';
import { AdminServer } from './AdminServer.js';
import { FitaRunner } from './FitaRunner.js';

/**
 * Administração das fitas: `npm run admin` (opções: --abrir, --porta <n>). Só no próprio computador (127.0.0.1).
 * ADMIN_PORT (padrão 8770), ADMIN_TOKEN (fixo; vazio gera um a cada início) e ADMIN_FITA_PORTA_BASE (padrão 8810:
 * portas do chat web das fitas ligadas pela página). No Docker: ADMIN_HOST (0.0.0.0 dentro do container),
 * ADMIN_DOMINIOS (domínios atrás do Cloudflare Access, separados por vírgula) e ADMIN_LIGAR (fitas que sobem junto).
 * Login pelo domínio: CF_ACCESS_EQUIPE, CF_ACCESS_AUD e ADMIN_DONOS (e-mails donos; os outros na aba Pessoas).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--porta');
  Logger.setLevel((process.env.LOG_LEVEL as never) || 'info');
  const rootDir = process.cwd();
  // Login pelo domínio (Cloudflare Access): equipe = <nome>.cloudflareaccess.com e a etiqueta AUD da aplicação.
  const equipe = process.env.CF_ACCESS_EQUIPE?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = process.env.CF_ACCESS_AUD?.trim();
  const server = new AdminServer({
    port: portIndex >= 0 ? Number(args[portIndex + 1]) || 8770 : positive(process.env.ADMIN_PORT, 8770),
    rootDir,
    env: process.env,
    ...(process.env.ADMIN_TOKEN?.trim() ? { token: process.env.ADMIN_TOKEN.trim() } : {}),
    ...(process.env.ADMIN_HOST?.trim() ? { host: process.env.ADMIN_HOST.trim() } : {}),
    dominios: list(process.env.ADMIN_DOMINIOS).map((d) => d.toLowerCase()),
    ...(equipe && aud ? { acesso: new AcessoCloudflare({ equipe, aud }) } : {}),
    pessoas: new PessoasDaAdmin(
      path.join(process.env.DADOS_DIR?.trim() || path.join(rootDir, 'dados'), 'k7', 'admin-pessoas.json'),
      list(process.env.ADMIN_DONOS).map((e) => e.toLowerCase()),
    ),
    runner: new FitaRunner({ rootDir, webPortBase: positive(process.env.ADMIN_FITA_PORTA_BASE, 8810) }),
  });
  await server.start();
  process.stdout.write(`\n📼 Administração das fitas (só neste computador): ${server.url}\n\n`);
  for (const fita of list(process.env.ADMIN_LIGAR)) {
    try {
      server.ligar(fita);
      process.stdout.write(`▶️ Fita "${fita}" ligada (ADMIN_LIGAR)\n`);
    } catch (error) {
      process.stderr.write(`⚠️ Não liguei a fita "${fita}": ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
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

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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
