import fs from 'node:fs';
import path from 'node:path';
import { ProcessRunner } from '../../utils/ProcessRunner.js';

export interface ServiceState {
  nome: string;
  arquivo: string;
  /** Containers do serviço e o estado de cada um (running, exited...). */
  containers: Array<{ nome: string; estado: string }>;
  rodando: boolean;
  erro?: string;
}

/**
 * Serviços em Docker que a fita traz (`servicos/<nome>/docker-compose.yml`, como o yt-dlp da Rebobina): ver se
 * estão no ar, subir e parar, pela página de administração. Usa o `docker compose` da máquina.
 */
export class FitaServices {
  constructor(private readonly runner = new ProcessRunner()) {}

  list(fitaDir: string): Array<{ nome: string; arquivo: string }> {
    const dir = path.join(fitaDir, 'servicos');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].map((f) => path.join(dir, d.name, f)).filter((f) => fs.existsSync(f)).slice(0, 1).map((arquivo) => ({ nome: d.name, arquivo })));
  }

  async state(fitaDir: string): Promise<ServiceState[]> {
    return Promise.all(
      this.list(fitaDir).map(async ({ nome, arquivo }) => {
        try {
          const result = await this.runner.run('docker', ['compose', '-f', arquivo, 'ps', '-a', '--format', 'json'], 20_000);
          if (result.code !== 0) return { nome, arquivo, containers: [], rodando: false, erro: lastLine(result.stderr) };
          const containers = parsePs(result.stdout).map((c) => ({ nome: c.Name ?? c.Service ?? '?', estado: c.State ?? '?' }));
          return { nome, arquivo, containers, rodando: containers.some((c) => c.estado === 'running') };
        } catch (error) {
          return { nome, arquivo, containers: [], rodando: false, erro: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  /** Sobe (`up -d`, construindo a imagem se faltar) ou para (`stop`) um serviço da fita. */
  async set(fitaDir: string, nome: string, on: boolean): Promise<{ ok: boolean; saida: string }> {
    const service = this.list(fitaDir).find((s) => s.nome === nome);
    if (!service) throw new Error(`serviço "${nome}" não encontrado na fita`);
    const args = on ? ['compose', '-f', service.arquivo, 'up', '-d', '--build'] : ['compose', '-f', service.arquivo, 'stop'];
    const result = await this.runner.run('docker', args, 15 * 60_000);
    return { ok: result.code === 0, saida: (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-15).join('\n') };
  }
}

/** `docker compose ps --format json`: um JSON por linha (versões novas) ou uma lista (antigas). */
function parsePs(output: string): Array<{ Name?: string; Service?: string; State?: string }> {
  const text = output.trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text) as Array<{ Name?: string; State?: string }>;
  return text.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as { Name?: string; State?: string }];
    } catch {
      return [];
    }
  });
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop() ?? 'erro desconhecido';
}
