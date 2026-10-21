import type { Config, ProviderName } from '../config/Config.js';
import { UserFacingError } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';
import { FallbackLlmProvider } from './FallbackLlmProvider.js';
import type { ProviderSettings } from './OpenAICompatibleProvider.js';
import type { ILlmProvider } from './types.js';
import { DeepSeekProvider } from './providers/DeepSeekProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { GroqProvider } from './providers/GroqProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';

type ProviderConstructor = new (settings: ProviderSettings) => ILlmProvider;

/**
 * Factory de "cérebros". Trocar `LLM_PROVIDER=gemini` por `deepseek` (ou `ollama`)
 * no .env basta para redirecionar os prompts ao outro endpoint.
 */
export class ProviderFactory {
  private static readonly registry: Record<ProviderName, ProviderConstructor> = {
    gemini: GeminiProvider,
    deepseek: DeepSeekProvider,
    groq: GroqProvider,
    ollama: OllamaProvider,
  };

  private readonly logger = new Logger('ProviderFactory');

  constructor(private readonly config: Config) {}

  /** Instancia um único provider. Retorna `undefined` se não houver API key. */
  create(name: ProviderName): ILlmProvider | undefined {
    const credentials = this.config.providers[name];
    if (!credentials.apiKey) return undefined;
    const Provider = ProviderFactory.registry[name];
    return new Provider({
      apiKey: credentials.apiKey,
      model: credentials.model,
      baseUrl: credentials.baseUrl,
      timeoutMs: credentials.timeoutMs ?? this.config.llmTimeoutMs,
      temperature: this.config.llmTemperature,
      think: credentials.think,
      maxTokens: credentials.maxTokens,
      reasoningEffort: credentials.reasoningEffort,
    });
  }

  /**
   * Provider com modelo específico (papéis das skills de refinamento).
   * Lança `UserFacingError` se o provider não tiver API key configurada.
   */
  createForRole(name: ProviderName, model?: string): ILlmProvider {
    const credentials = this.config.providers[name];
    if (!credentials.apiKey) {
      throw new UserFacingError(`O provider "${name}" não tem API key no .env.`, `Provider ${name} sem API key`);
    }
    return new ProviderFactory.registry[name]({
      apiKey: credentials.apiKey,
      model: model ?? credentials.model,
      baseUrl: credentials.baseUrl,
      timeoutMs: credentials.timeoutMs ?? this.config.llmTimeoutMs,
      temperature: this.config.llmTemperature,
      think: credentials.think,
      maxTokens: credentials.maxTokens,
      reasoningEffort: credentials.reasoningEffort,
    });
  }

  /** Cadeia principal + fallbacks configurados (os sem API key são ignorados com aviso). */
  createWithFallback(primary: ProviderName = this.config.llmProvider): FallbackLlmProvider {
    const names = [primary, ...this.config.llmFallbackProviders.filter((name) => name !== primary)];
    const chain: ILlmProvider[] = [];
    for (const name of names) {
      const provider = this.create(name);
      if (provider) chain.push(provider);
      else this.logger.warn(`Provider "${name}" ignorado: API key ausente no .env`);
    }
    if (chain.length === 0) throw new Error(`Nenhum provider utilizável (verifique a API key de "${primary}")`);
    return new FallbackLlmProvider(chain);
  }
}
