import { MaxIterationsError, errorMessage } from '../errors/AppErrors.js';
import type { ChatMessage, ILlmProvider, ToolCall } from '../llm/types.js';
import { ToolArgumentError } from '../tools/BaseTool.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { Logger, preview } from '../utils/Logger.js';
import { truncate } from '../utils/text.js';

export interface AgentRunInput {
  systemPrompt: string;
  /** Histórico (janela de memória), terminando na mensagem atual do usuário. */
  history: ChatMessage[];
}

export interface AgentStep {
  iteration: number;
  thought: string | null;
  tool: string;
  arguments: string;
  observation: string;
}

export interface AgentRunResult {
  text: string;
  iterations: number;
  steps: AgentStep[];
  providerName: string;
}

export const INVALID_JSON_OBSERVATION = 'JSON inválido, reenvie a estrutura corrigida por favor.';

/**
 * Motor ReAct: Thought → Action (tool call) → Observation → ... → Answer.
 * Estado vive apenas em RAM durante a execução; quem persiste é o MemoryManager.
 */
export class AgentLoop {
  private readonly logger = new Logger('AgentLoop');

  constructor(
    private readonly provider: ILlmProvider,
    private readonly registry: ToolRegistry,
    private readonly maxIterations: number,
    private readonly maxObservationChars = 20_000,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt }, ...input.history];
    const tools = this.registry.toDefinitions();
    const steps: AgentStep[] = [];

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      this.logger.info(`── Iteração ${iteration}/${this.maxIterations} ──`);
      const response = await this.provider.chat({ messages, tools });

      if (response.toolCalls.length === 0) {
        const answer = response.content?.trim();
        if (!answer) {
          this.logger.warn('LLM retornou resposta vazia; solicitando nova resposta');
          messages.push({ role: 'user', content: 'Sua resposta anterior veio vazia. Responda ao usuário agora.' });
          continue;
        }
        this.logger.info(`✅ Answer (${response.providerName}): ${preview(answer, 200)}`);
        return { text: answer, iterations: iteration, steps, providerName: response.providerName };
      }

      const thought = response.content?.trim() || null;
      if (thought) this.logger.info(`💭 Thought: ${preview(thought)}`);
      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

      // NG-02: tool calls executadas em cascata sequencial, nunca em paralelo.
      for (const call of response.toolCalls) {
        this.logger.info(`🔧 Action: ${call.name}(${preview(call.arguments, 200)})`);
        const observation = truncate(await this.executeTool(call), this.maxObservationChars);
        this.logger.info(`👁️  Observation: ${preview(observation)}`);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: observation });
        steps.push({ iteration, thought, tool: call.name, arguments: call.arguments, observation });
      }
    }

    this.logger.warn(`⛔ MAX_ITERATIONS (${this.maxIterations}) atingido; abortando loop`);
    throw new MaxIterationsError(this.maxIterations);
  }

  /** Executa uma tool call e SEMPRE devolve uma observação (nunca lança). */
  private async executeTool(call: ToolCall): Promise<string> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = this.registry.list().map((item) => item.name).join(', ');
      return JSON.stringify({ error: `Ferramenta "${call.name}" não existe. Disponíveis: ${available || 'nenhuma'}` });
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      args = parsed as Record<string, unknown>;
    } catch {
      // EC-01: argumentos malformados viram observação para o LLM corrigir.
      return INVALID_JSON_OBSERVATION;
    }

    try {
      const result = await tool.execute(args);
      return result.output;
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        return JSON.stringify({ error: error.message, hint: 'Reenvie a chamada respeitando o schema da ferramenta.' });
      }
      // EC-02: erro "hard" da ferramenta volta como observação para a IA corrigir.
      return JSON.stringify({ error: errorMessage(error) });
    }
  }
}
