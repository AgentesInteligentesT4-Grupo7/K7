import fs from 'node:fs';
import path from 'node:path';

export class SandboxViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolationError';
  }
}

/**
 * Restringe as ferramentas de arquivo a um diretório raiz (WORKSPACE_DIR).
 * Caminhos são sempre relativos; tentativas de escapar (`..`, absolutos,
 * caracteres estranhos) são rejeitadas. Mensagens nunca expõem o path absoluto.
 */
export class WorkspaceSandbox {
  private static readonly SAFE_PATH = /^[\p{L}\p{N} _.\-/\\()]+$/u;

  constructor(readonly root: string) {}

  ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Resolve um caminho relativo dentro do workspace ou lança `SandboxViolationError`. */
  resolve(relativePath: string): string {
    const cleaned = relativePath.trim().replace(/^\.?[/\\]+/, '');
    if (cleaned === '' || cleaned === '.') return this.root;
    if (!WorkspaceSandbox.SAFE_PATH.test(cleaned)) {
      throw new SandboxViolationError(`Caminho contém caracteres não permitidos: "${relativePath}"`);
    }
    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
      throw new SandboxViolationError('Use apenas caminhos relativos ao workspace.');
    }
    const resolved = path.resolve(this.root, cleaned);
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SandboxViolationError(`Caminho fora do workspace não é permitido: "${relativePath}"`);
    }
    return resolved;
  }

  /** Representação relativa e segura para devolver ao LLM. */
  display(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath).split(path.sep).join('/');
    return relative === '' ? '.' : relative;
  }
}
