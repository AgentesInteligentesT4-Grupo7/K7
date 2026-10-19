import type { JsonSchema, ToolDefinition } from '../llm/types.js';

export interface ToolResult {
  output: string;
}

/** Argumentos não respeitam o JSON Schema da ferramenta. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

/**
 * Classe base de toda ferramenta acionável pelo AgentLoop.
 * Subclasses declaram nome, descrição e JSON Schema, e implementam `run`.
 */
export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: JsonSchema;

  /** Valida os argumentos contra o schema e executa a ferramenta. */
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    this.validate(args);
    return this.run(args);
  }

  protected abstract run(args: Record<string, unknown>): Promise<ToolResult>;

  toDefinition(): ToolDefinition {
    return { name: this.name, description: this.description, parameters: this.parameters };
  }

  protected validate(args: Record<string, unknown>): void {
    for (const key of this.parameters.required ?? []) {
      if (args[key] === undefined || args[key] === null) {
        throw new ToolArgumentError(`Parâmetro obrigatório ausente: "${key}"`);
      }
    }
    for (const [key, value] of Object.entries(args)) {
      const spec = this.parameters.properties[key];
      if (!spec) {
        if (this.parameters.additionalProperties === false) {
          throw new ToolArgumentError(`Parâmetro desconhecido: "${key}"`);
        }
        continue;
      }
      const actual = Array.isArray(value) ? 'array' : typeof value;
      const expected = spec.type === 'integer' ? 'number' : spec.type;
      if (value !== undefined && value !== null && actual !== expected) {
        throw new ToolArgumentError(`Parâmetro "${key}" deveria ser ${spec.type}, recebido ${actual}`);
      }
      if (spec.enum && typeof value === 'string' && !spec.enum.includes(value)) {
        throw new ToolArgumentError(`Parâmetro "${key}" deve ser um de: ${spec.enum.join(', ')}`);
      }
    }
  }
}
