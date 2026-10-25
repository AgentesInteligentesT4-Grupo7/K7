import 'dotenv/config';
import { Logger } from '../../utils/Logger.js';
import { SiteServer } from './SiteServer.js';
import { showcaseTapes } from './showcase.js';

/**
 * Site do K7: `npm run site`. Mostra as fitas com `vitrine: true` no perfil.yaml e abre o chat da escolhida
 * pelo mesmo endereço. SITE_HOST (padrão 127.0.0.1; 0.0.0.0 abre na rede), SITE_PORT (padrão 8780) e
 * SITE_FITA_PORTA_BASE (padrão 8800: portas internas, só 127.0.0.1, dos chats das fitas).
 */
const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

async function main(): Promise<void> {
  Logger.setLevel(process.env.LOG_LEVEL?.trim() || 'info');
  const site = new SiteServer({
    host: process.env.SITE_HOST?.trim() || '127.0.0.1',
    port: positive(process.env.SITE_PORT, 8780),
    tapeBasePort: positive(process.env.SITE_FITA_PORTA_BASE, 8800),
    listTapes: () => showcaseTapes(),
  });
  await site.start();
  process.stdout.write(`\n📼 K7 no navegador: ${site.url}\n\n`);
  const shutdown = async (): Promise<void> => {
    await site.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') process.stderr.write('Porta em uso: defina outra em SITE_PORT.\n');
  else process.stderr.write(`Falha fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
