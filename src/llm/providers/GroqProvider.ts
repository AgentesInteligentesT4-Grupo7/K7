import { OpenAICompatibleProvider, type ProviderSettings } from '../OpenAICompatibleProvider.js';

/** Groq (inferência rápida e barata, útil para o SkillRouter). */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(settings: ProviderSettings) {
    super({
      name: 'groq',
      baseUrl: settings.baseUrl ?? 'https://api.groq.com/openai/v1',
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      defaultTemperature: settings.temperature,
      retryDelaysMs: settings.retryDelaysMs,
    });
  }
}
