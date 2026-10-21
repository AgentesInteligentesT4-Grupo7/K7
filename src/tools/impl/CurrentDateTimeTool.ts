import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, type ToolResult } from '../BaseTool.js';

export class CurrentDateTimeTool extends BaseTool {
  readonly name = 'obter_data_hora';
  readonly description = 'Retorna a data e hora atuais do computador local (com fuso horário).';
  readonly parameters: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

  protected async run(): Promise<ToolResult> {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const formatted = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'long', timeZone }).format(now);
    return { output: JSON.stringify({ iso: now.toISOString(), local: formatted, timeZone }) };
  }
}
