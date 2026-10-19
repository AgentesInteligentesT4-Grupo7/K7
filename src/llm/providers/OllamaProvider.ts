import { LlmProviderError } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { OpenAICompatibleProvider, type ProviderSettings } from '../OpenAICompatibleProvider.js';
import type { LlmRequest, LlmResponse } from '../types.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/**
 * LLM 100% local via Ollama (endpoint compatível com OpenAI).
 * - Não exige API key.
 * - Se o modelo não suportar tool calling, repete a chamada sem tools e lembra disso.
 * - Remove blocos <think> de modelos de raciocínio (qwen3, deepseek-r1).
 */
export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly logger = new Logger('Ollama');
  private readonly think: boolean;
  private readonly maxTokens: number;
  private toolsUnsupported = false;

  constructor(settings: ProviderSettings) {
    super({
      name: 'ollama',
      baseUrl: settings.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
      apiKey: settings.apiKey || 'ollama',
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      defaultTemperature: settings.temperature,
      retryDelaysMs: settings.retryDelaysMs,
    });
    this.think = settings.think ?? false;
    this.maxTokens = settings.maxTokens ?? 4096;
  }

  /**
   * - Sem raciocínio estendido, o qwen3:8b responde em ~5s em vez de ~80s.
   * - `max_tokens` é obrigatório na prática: o Ollama não limita a geração por padrão
   *   e, ao encher o contexto, continua gerando; uma resposta "em loop" segura o modelo
   *   por minutos mesmo depois do timeout do cliente, travando as chamadas seguintes.
   */
  protected override extraBody(): Record<string, unknown> {
    return { max_tokens: this.maxTokens, ...(this.think ? {} : { reasoning_effort: 'none' }) };
  }

  override async chat(request: LlmRequest): Promise<LlmResponse> {
    const wantsTools = Boolean(request.tools?.length);
    try {
      return OllamaProvider.stripThinking(
        await super.chat(this.toolsUnsupported ? { ...request, tools: undefined } : request),
      );
    } catch (error) {
      if (wantsTools && !this.toolsUnsupported && OllamaProvider.isToolsUnsupported(error)) {
        this.toolsUnsupported = true;
        this.logger.warn(`Modelo "${this.model}" não suporta tool calling; seguindo sem ferramentas`);
        return OllamaProvider.stripThinking(await super.chat({ ...request, tools: undefined }));
      }
      throw this.withHint(error);
    }
  }

  /** Confere se o servidor responde e se o modelo configurado já foi baixado. */
  override async healthCheck(): Promise<void> {
    let data: { data?: Array<{ id?: string }> };
    try {
      data = (await this.request('/models', { method: 'GET' })) as typeof data;
    } catch (error) {
      throw this.withHint(error);
    }
    const ids = (data.data ?? []).map((model) => model.id ?? '');
    const found = ids.some((id) => id === this.model || id === `${this.model}:latest`);
    if (!found) {
      throw new LlmProviderError(
        this.name,
        `Modelo "${this.model}" não encontrado no Ollama local. Rode: ollama pull ${this.model}`,
        404,
      );
    }
  }

  private withHint(error: unknown): unknown {
    if (error instanceof LlmProviderError && error.status === undefined && /erro de rede/.test(error.message)) {
      return new LlmProviderError(
        this.name,
        `Ollama inacessível em ${this.options.baseUrl}. Ele está rodando? (ollama serve)`,
        undefined,
        { cause: error },
      );
    }
    return error;
  }

  private static isToolsUnsupported(error: unknown): boolean {
    return error instanceof LlmProviderError && error.status === 400 && /does not support tools/i.test(error.message);
  }

  static stripThinking(response: LlmResponse): LlmResponse {
    if (!response.content) return response;
    const content = response.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return { ...response, content: content || null };
  }
}
