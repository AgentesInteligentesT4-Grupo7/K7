import path from 'node:path';
import { ConfigError } from '../config/Config.js';
import { AudioLeveler } from '../modules/midia/AudioLeveler.js';
import { MediaDownloader } from '../modules/midia/MediaDownloader.js';
import { MediaLibrary } from '../modules/midia/MediaLibrary.js';
import { YtdlpClient } from '../modules/midia/YtdlpClient.js';
import { loadConfig } from '../profiles/ProfileLoader.js';
import { ProfileError } from '../profiles/ProfileManifest.js';

/**
 * `npm run padronizar -- --perfil <fita>`: padroniza os nomes e as etiquetas da pasta de downloads da fita
 * ("Título - Artista", sem "(2)" nem "(Official Video)"); repetidas viram uma só, e o índice e a biblioteca acompanham.
 * Precisa do serviço servicos/ytdlp no ar (é ele que lê e grava as etiquetas).
 */
async function main(): Promise<void> {
  const config = loadConfig({ requireTelegram: false });
  if (!config.modules.has('midia')) throw new ConfigError('esta fita não liga o módulo "midia" (use --perfil rebobina)');
  const leveler = new AudioLeveler(config.midia);
  const downloader = new MediaDownloader(new YtdlpClient(config.midia), config.workspaceDir, new MediaLibrary(config.workspaceDir));
  process.stdout.write(`✏️ Padronizando ${path.join(config.workspaceDir, 'downloads')}\n`);
  const result = await downloader.standardizeAll(leveler, (done, total, name) => {
    process.stdout.write(`\r  ${done + 1}/${total} ${name.slice(0, 70).padEnd(70)}`);
  });
  process.stdout.write(
    `\n✅ ${result.total} arquivo(s): ${result.renamed} renomeado(s), ${result.merged} repetido(s) unido(s)` +
      `${result.problems.length ? `, ${result.problems.length} com problema:\n  ${result.problems.join('\n  ')}` : ''}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ProfileError) process.stderr.write(`Perfil: ${error.message}\n`);
  else if (error instanceof ConfigError) process.stderr.write(`Configuração: ${error.message}\n`);
  else process.stderr.write(`Falha: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
