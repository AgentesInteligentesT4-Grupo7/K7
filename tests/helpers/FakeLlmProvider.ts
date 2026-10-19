import type { ILlmProvider, LlmRequest, LlmResponse, ToolCall } from '../../src/llm/types.js';

export type ScriptedReply = { content?: string | null; toolCalls?: ToolCall[] } | Error;

/** Provider determinístico para testes: devolve respostas roteirizadas em ordem. */
export class FakeLlmProvider implements ILlmProvider {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: ScriptedReply[],
    readonly name = 'fake',
    readonly model = 'fake-model',
  ) {}

  async chat(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift() ?? { content: 'fim do roteiro' };
    if (next instanceof Error) throw next;
    return {
      content: next.content ?? null,
      toolCalls: next.toolCalls ?? [],
      providerName: this.name,
      model: this.model,
    };
  }

  async healthCheck(): Promise<void> {}
}

export const toolCall = (name: string, args: string, id = `call_${name}`): ToolCall => ({ id, name, arguments: args });
