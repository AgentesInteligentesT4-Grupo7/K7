import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../config/Config.js';
import { ExtensionHost } from '../fitas/ExtensionHost.js';
import { listProfiles, loadConfig, loadProfile, playerVersion, profileDirs } from '../profiles/ProfileLoader.js';
import { ProfileError } from '../profiles/ProfileManifest.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { Logger } from '../utils/Logger.js';

const USAGE = `Uso: npm run fita -- <fita> <comando> [argumentos]

  <fita> testes       roda os testes da fita (testes/*.test.ts)
  <fita>              lista os comandos que a extensão da fita oferece
  <fita> <comando>    roda um comando da extensão (ex.: npm run fita -- rebobina padronizar)`;

/** Comandos das extensões de fita, fora do chat (manutenção, conversões, testes). */
async function main(): Promise<void> {
  const [name, command, ...rest] = process.argv.slice(2);
  const rootDir = process.cwd();
  const dirs = profileDirs(process.env, rootDir);
  if (!name || name.startsWith('-')) {
    const withCode = listProfiles(dirs).filter((p) => p.manifest?.extensao);
    process.stdout.write(`${USAGE}\n\nFitas com extensão: ${withCode.map((p) => p.name).join(', ') || '(nenhuma)'}\n`);
    return;
  }

  if (command === 'testes') {
    const profile = loadProfile(name, dirs, playerVersion(rootDir));
    if (!fs.existsSync(path.join(profile.dir, 'testes'))) throw new ProfileError(`a fita ${name} não tem a pasta testes/`);
    // O tsx vem do tocador: a fita não precisa de node_modules próprio.
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--test', 'testes/**/*.test.ts'], { cwd: profile.dir, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
    return;
  }

  Logger.setLevel('warn');
  const config = loadConfig({ argv: ['--perfil', name], requireTelegram: false });
  const host = new ExtensionHost(config, new ToolRegistry());
  if (!host.enabled) throw new ProfileError(`a fita ${name} não tem extensão (campo "extensao" do perfil.yaml)`);
  await host.load();
  const found = host.commands.find((c) => c.name === command);
  if (!found) {
    const list = host.commands.map((c) => `  ${c.name.padEnd(18)} ${c.description}`).join('\n');
    process.stdout.write(`${command ? `Comando desconhecido: ${command}\n\n` : ''}Comandos da fita ${name}:\n${list || '  (nenhum)'}\n  ${'testes'.padEnd(18)} roda os testes da fita\n`);
    if (command) process.exitCode = 1;
    return;
  }
  await found.run(rest);
}

main().catch((error: unknown) => {
  if (error instanceof ProfileError) process.stderr.write(`Fita: ${error.message}\n`);
  else if (error instanceof ConfigError) process.stderr.write(`Configuração: ${error.message}\n`);
  else process.stderr.write(`Falha: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
