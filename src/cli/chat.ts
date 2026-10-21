import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createCore } from '../app/createCore.js';
import { Config, ConfigError } from '../config/Config.js';
import { DatabaseConnection } from '../memory/DatabaseConnection.js';
import { Logger } from '../utils/Logger.js';
import { OrchestratorCommands } from '../llm/orchestration/OrchestratorCommands.js';
import { TERMINAL_HELP, TerminalChat } from './TerminalChat.js';
import { TerminalOutputHandler } from './TerminalOutputHandler.js';

/**
 * Canal terminal: `npm run chat` (opções: --verbose, --play, --usuario <id do Telegram>).
 * Usa o mesmo núcleo do bot e pode rodar ao mesmo tempo que ele.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const userIndex = args.indexOf('--usuario');
  const userId = userIndex >= 0 && args[userIndex + 1] ? args[userIndex + 1]! : 'terminal';

  // Console do Windows em UTF-8 (acentos e emojis).
  if (process.platform === 'win32') {
    try {
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {
      // sem impacto funcional
    }
  }

  const config = new Config(process.env, process.cwd(), { requireTelegram: false });
  Logger.setLevel(flag('verbose') ? 'info' : 'warn');

  const core = createCore(config, {
    // Pasta temporária própria: o bot limpa ./tmp ao reiniciar e não pode apagar arquivos do terminal.
    tmpDir: path.join(os.tmpdir(), 'agrominds-cli'),
    cleanTmp: true,
    databaseMaintenance: false,
    healthChecks: flag('verbose'),
  });

  const output = new TerminalOutputHandler({
    outputDir: path.resolve(path.dirname(config.dbPath), 'terminal'),
    autoPlay: flag('play'),
    tts: core.tts,
    clonedVoices: core.voiceClone,
    label: `${config.identity.emoji} ${config.identity.name}`,
  });
  const chat = new TerminalChat({
    controller: core.createController(output),
    output,
    documents: core.documents,
    stt: core.stt,
    voiceClone: core.voiceClone,
    userId,
    voiceId: core.tts.voice,
    maxDocumentChars: config.maxDocumentChars,
    orchestratorCommands: core.orchestrator ? new OrchestratorCommands(core.orchestrator, config.orchestrator.privacyDefault) : undefined,
  });

  // Com o orquestrador, carrega o catálogo de modelos gratuitos antes de mostrar o banner.
  await core.orchestrator?.provider.refresh();
  const skills = core.skillLoader.loadAll().map((s) => s.name);
  process.stdout.write(
    [
      '',
      `\x1b[1m\x1b[36m${config.identity.emoji} ${config.identity.name} — chat no terminal\x1b[0m`,
      `   LLM: ${core.llm.providerNames.join(' → ')} (${core.llm.model}) | conversa: ${userId}`,
      `   Skills: ${skills.join(', ') || '(nenhuma)'}`,
      '',
      TERMINAL_HELP,
      '',
    ].join('\n'),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[1mvocê › \x1b[0m' });
  const shutdown = (): never => {
    rl.close();
    DatabaseConnection.close();
    process.stdout.write('\nAté mais! 👋\n');
    process.exit(0);
  };
  rl.on('SIGINT', shutdown);
  rl.prompt();

  // Uma linha por vez: a próxima só é lida depois que a resposta anterior terminar.
  for await (const line of rl) {
    rl.pause();
    if ((await chat.handleLine(line)) === 'exit') shutdown();
    rl.resume();
    rl.prompt();
  }
  shutdown();
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`Configuração inválida: ${error.message}\nCopie .env.example para .env e preencha as variáveis.\n`);
  } else {
    process.stderr.write(`Falha fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  DatabaseConnection.close();
  process.exit(1);
});
