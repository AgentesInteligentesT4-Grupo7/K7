import { MaxIterationsError, UserFacingError, errorMessage } from '../errors/AppErrors.js';
import type { ChatMessage, ILlmProvider, ToolCall } from '../llm/types.js';
import { ToolArgumentError } from '../tools/BaseTool.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { Logger, preview } from '../utils/Logger.js';
import { truncate } from '../utils/text.js';

export interface AgentRunInput {
  systemPrompt: string;
  /** Histórico (janela de memória), terminando na mensagem atual do usuário. */
  history: ChatMessage[];
  /** Limite de iterações desta execução (skill com max_iterations); padrão: MAX_ITERATIONS. */
  maxIterations?: number;
  /** Ao estourar o limite, pede uma resposta final com o que já foi levantado em vez de falhar (spec web-search EC-08). */
  finishOnLimit?: boolean;
  /**
   * A skill só funciona via ferramenta (ex.: gerar imagem): resposta sem nenhuma chamada e que não é pergunta
   * volta para o modelo uma vez. Modelos menores "fingem" o resultado imitando respostas do histórico.
   */
  requireToolUse?: boolean;
}

export const NO_TOOL_CORRECTION =
  'Atenção: você respondeu sem chamar nenhuma ferramenta, então NADA foi feito (nenhuma imagem foi gerada). Não descreva resultados, seeds ou tempos que não aconteceram. Se o pedido é uma ação, chame a ferramenta agora; se falta uma informação essencial, faça só a pergunta.';

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
    /** Guardrail de conteúdo externo: marca observações com cara de injeção antes de chegarem ao LLM. */
    private readonly inspectObservation?: (tool: string, output: string) => string,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [{ role: 'system', content: input.systemPrompt }, ...input.history];
    const tools = this.registry.toDefinitions();
    const steps: AgentStep[] = [];

    const limit = input.maxIterations ?? this.maxIterations;
    let corrected = false;
    for (let iteration = 1; iteration <= limit; iteration++) {
      this.logger.info(`── Iteração ${iteration}/${limit} ──`);
      const response = await this.provider.chat({ messages, tools });
      // Modelos locais menores às vezes escrevem a chamada como JSON no texto em vez de usar tool calling.
      if (response.toolCalls.length === 0) {
        const textCall = this.textToolCall(response.content, iteration);
        if (textCall) {
          this.logger.info(`🔧 Chamada de ferramenta escrita como texto reconhecida: ${textCall.name}`);
          response.toolCalls = [textCall];
          response.content = null;
        }
      }

      if (response.toolCalls.length === 0) {
        const answer = response.content?.trim();
        if (!answer) {
          this.logger.warn('LLM retornou resposta vazia; solicitando nova resposta');
          messages.push({ role: 'user', content: 'Sua resposta anterior veio vazia. Responda ao usuário agora.' });
          continue;
        }
        if (input.requireToolUse && steps.length === 0 && !corrected && !answer.trimEnd().endsWith('?')) {
          corrected = true;
          this.logger.warn('⚠️ Resposta sem chamar ferramenta numa skill que exige ação; pedindo para executar de verdade');
          messages.push({ role: 'assistant', content: answer }, { role: 'user', content: NO_TOOL_CORRECTION });
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
        const raw = truncate(await this.executeTool(call), this.maxObservationChars);
        const observation = this.inspectObservation ? this.inspectObservation(call.name, raw) : raw;
        this.logger.info(`👁️  Observation: ${preview(observation)}`);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: observation });
        steps.push({ iteration, thought, tool: call.name, arguments: call.arguments, observation });
      }
    }

    if (input.finishOnLimit) {
      this.logger.warn(`⛔ Limite de ${limit} iterações; pedindo a resposta final com o que já foi levantado`);
      messages.push({ role: 'user', content: 'Limite de passos atingido. Responda agora ao usuário com o que já levantou (cite as fontes já lidas), sem chamar ferramentas.' });
      const response = await this.provider.chat({ messages });
      const answer = response.content?.trim();
      if (answer) return { text: answer, iterations: limit, steps, providerName: response.providerName };
    }
    this.logger.warn(`⛔ MAX_ITERATIONS (${limit}) atingido; abortando loop`);
    throw new MaxIterationsError(limit);
  }

  /**
   * Resposta que é só um JSON {"name": "<ferramenta>", "arguments": {...}} (com ou sem bloco ```json),
   * de uma ferramenta registrada, vira tool call. Texto comum com JSON no meio não é tocado.
   */
  private textToolCall(content: string | null, iteration: number): ToolCall | undefined {
    const text = content?.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    if (!text?.startsWith('{') || !text.endsWith('}')) return undefined;
    try {
      const parsed = JSON.parse(text) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name : undefined;
      const args = parsed.arguments ?? parsed.parameters ?? {};
      if (!name || !this.registry.get(name) || typeof args !== 'object' || args === null) return undefined;
      return { id: `texto-${iteration}`, name, arguments: JSON.stringify(args) };
    } catch {
      return undefined;
    }
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
      return JSON.stringify({ error: error instanceof UserFacingError ? error.userMessage : errorMessage(error) });
    }
  }
}
