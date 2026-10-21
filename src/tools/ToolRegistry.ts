import type { ToolDefinition } from '../llm/types.js';
import type { BaseTool } from './BaseTool.js';

/** Registry de ferramentas disponíveis ao AgentLoop (registro dinâmico por nome). */
export class ToolRegistry {
  private readonly tools = new Map<string, BaseTool>();

  register(tool: BaseTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): BaseTool[] {
    return [...this.tools.values()];
  }

  toDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => tool.toDefinition());
  }

  get size(): number {
    return this.tools.size;
  }
}
