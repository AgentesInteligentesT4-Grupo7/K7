import fs from 'node:fs';
import path from 'node:path';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, type ToolResult } from '../BaseTool.js';
import type { WorkspaceSandbox } from '../WorkspaceSandbox.js';

export class CreateFileTool extends BaseTool {
  readonly name = 'criar_arquivo';
  readonly description =
    'Cria (ou sobrescreve) um arquivo de texto no workspace local do usuário. Use caminhos relativos, ex.: "notas/ideias.md".';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      caminho: { type: 'string', description: 'Caminho relativo ao workspace, incluindo extensão.' },
      conteudo: { type: 'string', description: 'Conteúdo completo do arquivo.' },
    },
    required: ['caminho', 'conteudo'],
    additionalProperties: false,
  };

  constructor(
    private readonly sandbox: WorkspaceSandbox,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.sandbox.resolve(String(args.caminho));
    const content = String(args.conteudo);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxBytes) throw new Error(`Conteúdo excede o limite de ${this.maxBytes} bytes`);

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content, 'utf8');
    return { output: `Arquivo "${this.sandbox.display(target)}" criado com sucesso (${bytes} bytes).` };
  }
}
