import { OpenAICompatibleProvider, type ProviderSettings } from '../OpenAICompatibleProvider.js';

/** DeepSeek (API nativamente compatível com OpenAI). */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(settings: ProviderSettings) {
    super({
      name: 'deepseek',
      baseUrl: settings.baseUrl ?? 'https://api.deepseek.com',
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      defaultTemperature: settings.temperature,
      retryDelaysMs: settings.retryDelaysMs,
    });
  }
}
