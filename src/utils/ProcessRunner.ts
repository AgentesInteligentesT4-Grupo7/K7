import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class ProcessNotFoundError extends Error {
  constructor(public readonly command: string) {
    super(`Executável não encontrado: ${command}`);
    this.name = 'ProcessNotFoundError';
  }
}

export class ProcessTimeoutError extends Error {
  constructor(public readonly command: string, public readonly timeoutMs: number) {
    super(`${command} excedeu o timeout de ${timeoutMs}ms`);
    this.name = 'ProcessTimeoutError';
  }
}

/** Executa um processo filho (sem shell) com timeout e captura de stdout/stderr. */
export class ProcessRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new ProcessTimeoutError(command, timeoutMs));
      }, timeoutMs);

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error.code === 'ENOENT' ? new ProcessNotFoundError(command) : error);
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }
}
