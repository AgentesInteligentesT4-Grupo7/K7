import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from './Logger.js';

/**
 * Gerencia arquivos temporários em `./tmp` (PDFs, áudios, documentos de saída).
 * Meta: 0 bytes residuais — todo arquivo criado aqui deve ser removido com `remove`
 * num bloco `finally`, e o diretório é varrido no startup.
 */
/** Subpastas do tmp que sobrevivem à limpeza de início. */
const PRESERVED = new Set(['imagens']);

export class TempFileManager {
  private readonly logger = new Logger('TempFiles');

  constructor(private readonly tmpDir: string) {}

  /**
   * Cria o diretório e remove resíduos de execuções anteriores (ex.: crash). Subpastas de `PRESERVED` ficam:
   * as imagens geradas têm a própria rotação (as 10 mais recentes) e não podem sumir a cada reinício.
   */
  initialize(): void {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    let removed = 0;
    for (const entry of fs.readdirSync(this.tmpDir)) {
      if (PRESERVED.has(entry)) continue;
      fs.rmSync(path.join(this.tmpDir, entry), { recursive: true, force: true });
      removed++;
    }
    if (removed > 0) this.logger.info(`${removed} resíduo(s) temporário(s) removido(s) de execuções anteriores`);
  }

  /** Gera um caminho único (não cria o arquivo). `extension` com ou sem ponto. */
  createPath(extension: string): string {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const ext = extension ? (extension.startsWith('.') ? extension : `.${extension}`) : '';
    return path.join(this.tmpDir, `${Date.now()}-${randomUUID()}${ext}`);
  }

  /** Cria um subdiretório único (para ferramentas que geram múltiplos arquivos de saída). */
  createDir(): string {
    const dir = this.createPath('');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Remove arquivos/diretórios sem lançar erro. */
  async remove(...targets: Array<string | undefined>): Promise<void> {
    for (const target of targets) {
      if (!target) continue;
      try {
        await fs.promises.rm(target, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(`Não foi possível remover temporário ${path.basename(target)}`, error);
      }
    }
  }
}
