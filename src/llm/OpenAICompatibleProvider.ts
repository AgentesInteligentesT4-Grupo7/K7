import { LlmProviderError, errorMessage } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import { sleep } from '../utils/text.js';
import type { ChatMessage, ILlmProvider, LlmRequest, LlmResponse, ToolCall } from './types.js';

/** Sobrecarga/limite temporário: vale tentar de novo em instantes. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [1_500, 4_000];
const MAX_RETRY_WAIT_MS = 10_000;

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  defaultTemperature: number;
  /** Esperas entre novas tentativas em falhas temporárias (padrão: 1,5s e 4s). */
  retryDelaysMs?: number[];
}

/** Parâmetros que a ProviderFactory repassa a cada provider concreto. */
export interface ProviderSettings {
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  /** Sobrescreve a URL base padrão do provider (ex.: Ollama em outra máquina). */
  baseUrl?: string;
  /** Modelos de raciocínio (qwen3, deepseek-r1): `false` desliga a fase de "thinking". */
  think?: boolean;
  /** Teto de tokens gerados por resposta. */
  maxTokens?: number;
  /** Nível de raciocínio (`reasoning_effort`: low | medium | high | none). Vazio = padrão do provider. */
  reasoningEffort?: string;
  retryDelaysMs?: number[];
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

interface WireCompletion {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
  }>;
}

/**
 * Provider base para APIs no formato OpenAI Chat Completions.
 * Gemini (endpoint OpenAI-compat), DeepSeek e Groq herdam desta classe,
 * mudando apenas URL base e modelo padrão.
 */
export class OpenAICompatibleProvider implements ILlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly retryLogger = new Logger('LLM');

  constructor(protected readonly options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.model = options.model;
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((message) => this.toWireMessage(message)),
      temperature: request.temperature ?? this.options.defaultTemperature,
      ...this.extraBody(),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const data = (await this.request('/chat/completions', { method: 'POST', body: JSON.stringify(body) })) as WireCompletion;
    const choice = data.choices?.[0];
    if (!choice?.message) throw new LlmProviderError(this.name, 'Resposta sem choices/message');

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, index) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        name: call.function!.name!,
        arguments: call.function?.arguments ?? '{}',
        ...(call.extra_content !== undefined ? { extraContent: call.extra_content } : {}),
      }));

    return {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason: choice.finish_reason,
      providerName: this.name,
      model: this.model,
    };
  }

  async healthCheck(): Promise<void> {
    await this.request('/models', { method: 'GET' });
  }

  /** Campos específicos do provider adicionados ao corpo de /chat/completions. */
  protected extraBody(): Record<string, unknown> {
    return {};
  }

  private toWireMessage(message: ChatMessage): Record<string, unknown> {
    const wire: Record<string, unknown> = { role: message.role, content: message.content };
    if (message.role === 'assistant' && message.toolCalls?.length) {
      wire.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
        ...(call.extraContent !== undefined ? { extra_content: call.extraContent } : {}),
      }));
    }
    if (message.role === 'tool') {
      wire.tool_call_id = message.toolCallId;
      if (message.name) wire.name = message.name;
    }
    return wire;
  }

  /**
   * Chamada com novas tentativas para falhas temporárias (429, 5xx, rede), como o
   * "503 high demand" do Gemini. Timeouts não são repetidos: já consumiram o tempo
   * todo, então o FallbackLlmProvider deve seguir para o próximo provider.
   */
  protected async request(pathname: string, init: { method: string; body?: string }): Promise<unknown> {
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce(pathname, init);
      } catch (error) {
        const retryable = error instanceof LlmProviderError && error.isTransient;
        if (!retryable || attempt >= delays.length) throw error;
        const waitMs = Math.min(error.retryAfterMs ?? delays[attempt]!, MAX_RETRY_WAIT_MS);
        this.retryLogger.warn(`${this.name}: ${error.message.slice(0, 120)} — nova tentativa ${attempt + 1}/${delays.length} em ${waitMs}ms`);
        await sleep(waitMs);
      }
    }
  }

  private async requestOnce(pathname: string, init: { method: string; body?: string }): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${pathname}`, {
        method: init.method,
        body: init.body,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      const reason = isTimeout ? `timeout após ${this.options.timeoutMs}ms` : `erro de rede: ${errorMessage(error)}`;
      throw new LlmProviderError(this.name, reason, undefined, { cause: error, transient: !isTimeout });
    }

    if (!response.ok) {
      // O corpo de erro vai apenas para o log técnico (nunca contém a key, que viaja no header).
      const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 500);
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      throw new LlmProviderError(this.name, `HTTP ${response.status}: ${detail}`, response.status, {
        transient: TRANSIENT_STATUS.has(response.status),
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : undefined,
      });
    }

    try {
      return await response.json();
    } catch (error) {
      throw new LlmProviderError(this.name, 'Resposta não é JSON válido', response.status, { cause: error });
    }
  }
}
