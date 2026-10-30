import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_LINES = 300;

export interface RunningState {
  rodando: boolean;
  pid: number | null;
  desde: string | null;
  /** Endereço do chat web da fita (com o token), lido do log quando o canal web sobe. */
  web: string | null;
  /** Como terminou a última vez (código de saída), para a página explicar ("faltou o token", etc.). */
  saida: number | null;
}

interface Entry {
  child: ChildProcess;
  desde: string;
  web: string | null;
  saida: number | null;
  log: string[];
}

/**
 * Liga e desliga fitas pela página de administração: cada fita roda num processo próprio (`main.ts --perfil`,
 * o mesmo do `npm run dev`), que sobe os canais do perfil.yaml (Telegram, web). Cada uma ganha uma porta web
 * própria, para várias rodarem juntas. O log fica guardado (últimas linhas) para a página mostrar.
 */
export class FitaRunner {
  private readonly entries = new Map<string, Entry>();
  private readonly ports = new Map<string, number>();

  constructor(
    private readonly options: { rootDir: string; webPortBase: number; launch?: (fita: string, port: number) => ChildProcess },
  ) {}

  state(fita: string): RunningState {
    const entry = this.entries.get(fita);
    const rodando = Boolean(entry && entry.child.exitCode === null && entry.child.signalCode === null);
    return { rodando, pid: rodando ? (entry!.child.pid ?? null) : null, desde: entry?.desde ?? null, web: rodando ? (entry?.web ?? null) : null, saida: entry?.saida ?? null };
  }

  log(fita: string): string[] {
    return this.entries.get(fita)?.log ?? [];
  }

  start(fita: string): RunningState {
    if (this.state(fita).rodando) return this.state(fita);
    const port = this.portFor(fita);
    const child = (this.options.launch ?? this.launch.bind(this))(fita, port);
    const entry: Entry = { child, desde: new Date().toISOString(), web: null, saida: null, log: [] };
    const take = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
        if (!line.trim()) continue;
        entry.log.push(line);
        const web = /(http:\/\/127\.0\.0\.1:\d+\/(?:#t=[\w-]+)?)/.exec(line);
        if (web && /Chat web|no navegador/.test(line)) entry.web = web[1]!;
      }
      if (entry.log.length > MAX_LOG_LINES) entry.log.splice(0, entry.log.length - MAX_LOG_LINES);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.once('exit', (code) => {
      entry.saida = code;
      entry.log.push(`— processo encerrado${code !== null ? ` (código ${code})` : ''} —`);
    });
    this.entries.set(fita, entry);
    return this.state(fita);
  }

  async stop(fita: string): Promise<RunningState> {
    const entry = this.entries.get(fita);
    if (entry && this.state(fita).rodando) {
      const exited = new Promise<void>((resolve) => entry.child.once('exit', () => resolve()));
      entry.child.kill('SIGTERM');
      // Se não sair em 8 s (ex.: bot esperando o Telegram), força.
      const timer = setTimeout(() => entry.child.kill('SIGKILL'), 8_000);
      await exited;
      clearTimeout(timer);
    }
    return this.state(fita);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((fita) => this.stop(fita)));
  }

  private portFor(fita: string): number {
    if (!this.ports.has(fita)) this.ports.set(fita, this.options.webPortBase + this.ports.size);
    return this.ports.get(fita)!;
  }

  private launch(fita: string, port: number): ChildProcess {
    const root = this.options.rootDir;
    const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const args = fs.existsSync(tsx) ? [tsx, path.join(root, 'src', 'main.ts')] : [path.join(root, 'dist', 'main.js')];
    return spawn(process.execPath, [...args, '--perfil', fita], {
      cwd: root,
      // LOG_LEVEL=info: o log mostra o endereço do chat web e o que a fita está fazendo.
      env: { ...process.env, WEB_PORT: String(port), LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
}
