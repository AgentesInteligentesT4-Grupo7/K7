import type { Config } from '../../config/Config.js';
import type { SqliteDatabase } from '../../memory/DatabaseConnection.js';
import type { ProcessRunner } from '../../utils/ProcessRunner.js';
import { CostGuard } from './CostGuard.js';
import { ModelCatalog } from './ModelCatalog.js';
import { ModelRanker } from './ModelRanker.js';
import { OrchestratedLlmProvider } from './OrchestratedLlmProvider.js';
import { ScoreStore } from './ScoreStore.js';

export interface Orchestrator {
  provider: OrchestratedLlmProvider;
  catalog: ModelCatalog;
  ranker: ModelRanker;
  scores: ScoreStore;
}

/** Monta o orquestrador de LLMs gratuitos a partir da configuração. */
export function createOrchestrator(config: Config, db: SqliteDatabase, runner?: ProcessRunner): Orchestrator {
  const oc = config.orchestrator;
  const catalog = new ModelCatalog(oc, config.providers.ollama.baseUrl ?? 'http://localhost:11434/v1', runner);
  const scores = new ScoreStore(db);
  const ranker = new ModelRanker(catalog, scores, new CostGuard(new Set(oc.freeSources)));
  const provider = new OrchestratedLlmProvider({
    catalog,
    ranker,
    scores,
    maxAttempts: oc.maxAttempts,
    privacyDefault: oc.privacyDefault,
    timeoutMs: config.providers.gemini.timeoutMs ?? config.llmTimeoutMs,
    ollamaTimeoutMs: config.providers.ollama.timeoutMs ?? config.llmTimeoutMs,
    temperature: config.llmTemperature,
    keys: { gemini: config.providers.gemini.apiKey, groq: config.providers.groq.apiKey },
    geminiReasoningEffort: config.providers.gemini.reasoningEffort,
  });
  return { provider, catalog, ranker, scores };
}
