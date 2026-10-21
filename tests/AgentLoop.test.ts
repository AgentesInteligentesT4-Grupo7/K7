import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentLoop, INVALID_JSON_OBSERVATION } from '../src/agent/AgentLoop.js';
import { MaxIterationsError } from '../src/errors/AppErrors.js';
import type { JsonSchema } from '../src/llm/types.js';
import { BaseTool, type ToolResult } from '../src/tools/BaseTool.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { FakeLlmProvider, toolCall } from './helpers/FakeLlmProvider.js';

class EchoTool extends BaseTool {
  readonly name = 'eco';
  readonly description = 'Ecoa o texto';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { texto: { type: 'string' } },
    required: ['texto'],
  };
  calls = 0;
  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    this.calls++;
    return { output: `eco: ${String(args.texto)}` };
  }
}

class FailingTool extends BaseTool {
  readonly name = 'quebra';
  readonly description = 'Sempre falha';
  readonly parameters: JsonSchema = { type: 'object', properties: {} };
  protected async run(): Promise<ToolResult> {
    throw new Error('ENOENT: path not exists');
  }
}

const history = [{ role: 'user' as const, content: 'oi' }];

function setup(script: ConstructorParameters<typeof FakeLlmProvider>[0], max = 5) {
  const provider = new FakeLlmProvider(script);
  const echo = new EchoTool();
  const registry = new ToolRegistry().register(echo).register(new FailingTool());
  return { provider, echo, loop: new AgentLoop(provider, registry, max) };
}

describe('AgentLoop', () => {
  it('retorna resposta direta quando não há tool call', async () => {
    const { loop, provider } = setup([{ content: 'Olá!' }]);
    const result = await loop.run({ systemPrompt: 'sys', history });
    assert.equal(result.text, 'Olá!');
    assert.equal(result.iterations, 1);
    assert.equal(provider.requests[0]!.messages[0]!.role, 'system');
    assert.equal(provider.requests[0]!.tools!.length, 2);
  });

  it('executa a ferramenta e devolve a observação ao LLM (Thought → Action → Observation)', async () => {
    const { loop, provider, echo } = setup([
      { content: 'Vou ecoar', toolCalls: [toolCall('eco', '{"texto":"Foo"}')] },
      { content: 'Arquivo Foo feito!' },
    ]);
    const result = await loop.run({ systemPrompt: 'sys', history });

    assert.equal(result.text, 'Arquivo Foo feito!');
    assert.equal(echo.calls, 1);
    assert.equal(result.steps.length, 1);
    const second = provider.requests[1]!.messages;
    const toolMessage = second.at(-1)!;
    assert.equal(toolMessage.role, 'tool');
    assert.equal(toolMessage.content, 'eco: Foo');
    assert.equal(toolMessage.toolCallId, 'call_eco');
    assert.equal(second.at(-2)!.toolCalls?.[0]?.name, 'eco');
  });

  it('EC-01: JSON malformado vira observação pedindo correção', async () => {
    const { loop, provider } = setup([
      { toolCalls: [toolCall('eco', '{texto: sem aspas')] },
      { content: 'ok' },
    ]);
    await loop.run({ systemPrompt: 'sys', history });
    assert.equal(provider.requests[1]!.messages.at(-1)!.content, INVALID_JSON_OBSERVATION);
  });

  it('EC-02: erro da ferramenta volta como {"error": ...}', async () => {
    const { loop, provider } = setup([{ toolCalls: [toolCall('quebra', '{}')] }, { content: 'ok' }]);
    await loop.run({ systemPrompt: 'sys', history });
    const observation = JSON.parse(provider.requests[1]!.messages.at(-1)!.content!);
    assert.match(observation.error, /ENOENT/);
  });

  it('argumentos fora do schema e ferramenta inexistente geram observações de erro', async () => {
    const { loop, provider } = setup([
      { toolCalls: [toolCall('eco', '{}', 'a'), toolCall('nao_existe', '{}', 'b')] },
      { content: 'ok' },
    ]);
    await loop.run({ systemPrompt: 'sys', history });
    const messages = provider.requests[1]!.messages;
    assert.match(messages.at(-2)!.content!, /obrigatório ausente/);
    assert.match(messages.at(-1)!.content!, /não existe/);
  });

  it('RF-02: para deterministicamente ao atingir MAX_ITERATIONS', async () => {
    const looping = Array.from({ length: 10 }, () => ({ toolCalls: [toolCall('eco', '{"texto":"x"}')] }));
    const { loop, provider } = setup(looping, 3);
    await assert.rejects(loop.run({ systemPrompt: 'sys', history }), (error: unknown) => {
      assert.ok(error instanceof MaxIterationsError);
      assert.match(error.userMessage, /3 iterações/);
      return true;
    });
    assert.equal(provider.requests.length, 3);
  });
});
