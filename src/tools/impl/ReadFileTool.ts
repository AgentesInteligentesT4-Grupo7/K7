import fs from 'node:fs';
import type { JsonSchema } from '../../llm/types.js';
import { truncate } from '../../utils/text.js';
import { BaseTool, type ToolResult } from '../BaseTool.js';
import type { WorkspaceSandbox } from '../WorkspaceSandbox.js';

export class ReadFileTool extends BaseTool {
  readonly name = 'ler_arquivo';
  readonly description = 'Lê o conteúdo de um arquivo de texto do workspace local do usuário.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      caminho: { type: 'string', description: 'Caminho relativo ao workspace.' },
    },
    required: ['caminho'],
    additionalProperties: false,
  };

  constructor(
    private readonly sandbox: WorkspaceSandbox,
    private readonly maxChars = 30_000,
  ) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.sandbox.resolve(String(args.caminho));
    const stat = await fs.promises.stat(target).catch(() => undefined);
    if (!stat) throw new Error(`ENOENT: arquivo "${this.sandbox.display(target)}" não existe no workspace`);
    if (!stat.isFile()) throw new Error(`"${this.sandbox.display(target)}" não é um arquivo`);
    const content = await fs.promises.readFile(target, 'utf8');
    return { output: truncate(content, this.maxChars) };
  }
}
