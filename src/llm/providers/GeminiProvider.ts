import { OpenAICompatibleProvider, type ProviderSettings } from '../OpenAICompatibleProvider.js';

/** Google Gemini via endpoint compatível com OpenAI. */
export class GeminiProvider extends OpenAICompatibleProvider {
  private readonly reasoningEffort: string | undefined;

  constructor(settings: ProviderSettings) {
    super({
      name: 'gemini',
      baseUrl: settings.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      defaultTemperature: settings.temperature,
      retryDelaysMs: settings.retryDelaysMs,
    });
    this.reasoningEffort = settings.reasoningEffort || undefined;
  }

  /** Gemini 3 pensa bastante por padrão; `low` corta a latência de ~24s para ~3s. */
  protected override extraBody(): Record<string, unknown> {
    return this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {};
  }
}
