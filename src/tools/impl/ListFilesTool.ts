import fs from 'node:fs';
import path from 'node:path';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, type ToolResult } from '../BaseTool.js';
import type { WorkspaceSandbox } from '../WorkspaceSandbox.js';

export class ListFilesTool extends BaseTool {
  readonly name = 'listar_arquivos';
  readonly description = 'Lista arquivos e pastas de um diretório do workspace local (não recursivo).';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      diretorio: { type: 'string', description: 'Diretório relativo ao workspace. Vazio = raiz.' },
    },
    additionalProperties: false,
  };

  constructor(
    private readonly sandbox: WorkspaceSandbox,
    private readonly maxEntries = 200,
  ) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    this.sandbox.ensureRoot();
    const dir = this.sandbox.resolve(typeof args.diretorio === 'string' ? args.diretorio : '');
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => {
      throw new Error(`ENOENT: diretório "${this.sandbox.display(dir)}" não existe no workspace`);
    });
    const lines = entries.slice(0, this.maxEntries).map((entry) => {
      const relative = this.sandbox.display(path.join(dir, entry.name));
      return entry.isDirectory() ? `[dir]  ${relative}/` : `[file] ${relative}`;
    });
    if (entries.length > this.maxEntries) lines.push(`... e mais ${entries.length - this.maxEntries} itens`);
    return { output: lines.length ? lines.join('\n') : '(diretório vazio)' };
  }
}
