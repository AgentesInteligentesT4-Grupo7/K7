import { AllProvidersFailedError, LlmProviderError, errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { OpenAICompatibleProvider } from '../OpenAICompatibleProvider.js';
import { GeminiProvider } from '../providers/GeminiProvider.js';
import { OllamaProvider } from '../providers/OllamaProvider.js';
import type { ILlmProvider, LlmRequest, LlmResponse } from '../types.js';
import type { ModelCatalog } from './ModelCatalog.js';
import type { ModelRanker, RankedModel } from './ModelRanker.js';
import type { ScoreStore } from './ScoreStore.js';
import { TaskContext } from './TaskContext.js';
import { type ModelCandidate, type PrivacyLevel, type Requirements, type Task, modelKey } from './types.js';

export interface OrchestratorDeps {
  catalog: ModelCatalog;
  ranker: ModelRanker;
  scores: ScoreStore;
  maxAttempts: number;
  privacyDefault: PrivacyLevel;
  timeoutMs: number;
  ollamaTimeoutMs: number;
  temperature: number;
  keys: { gemini?: string; groq?: string };
  geminiReasoningEffort?: string;
  /** Fábrica de providers (injetável nos testes). */
  createProvider?: (candidate: ModelCandidate) => ILlmProvider;
}

export interface Decision {
  task: Task;
  model: string;
  reason: string;
  at: Date;
}

const MINUTE = 60_000;

/**
 * Provider "virtual" que escolhe, a cada chamada, o melhor modelo gratuito para a tarefa
 * do contexto atual (spec llm-orchestration). Só modelos aprovados pela trava de custo.
 * Em cota esgotada (429) o modelo entra em cooldown e a chamada segue para o próximo.
 */
export class OrchestratedLlmProvider implements ILlmProvider {
  readonly name = 'orquestrador';
  private readonly logger = new Logger('Orquestrador');
  private readonly providers = new Map<string, ILlmProvider>();
  private readonly lastDecisions = new Map<string, Decision>();

  constructor(private readonly deps: OrchestratorDeps) {}

  get model(): string {
    return 'automático (gratuitos)';
  }

  get providerNames(): string[] {
    return this.deps.catalog.sourceStatuses.filter((s) => s.enabled && s.models > 0).map((s) => s.source);
  }

  /** Última escolha para um usuário (comando /modelo). Ignora o passo zero (roteamento). */
  lastDecision(userId: string): Decision | undefined {
    return this.lastDecisions.get(userId);
  }

  async refresh(force = false): Promise<void> {
    await this.deps.catalog.refresh(this.deps.keys, force);
  }

  async chat(request: LlmRequest): Promise<LlmResponse> {
    await this.refresh();
    const ctx = TaskContext.current() ?? { task: 'conversa' as Task, privacy: this.deps.privacyDefault, userId: 'desconhecido' };
    const requirements = OrchestratedLlmProvider.requirementsFor(request);
    const ranked = this.deps.ranker.rank(ctx.task, ctx.privacy, requirements);

    // Modelo fixado neste ciclo do AgentLoop vai primeiro (continuidade das tool calls).
    if (ctx.pinned) {
      const index = ranked.findIndex((r) => modelKey(r.candidate) === ctx.pinned);
      if (index > 0) ranked.unshift(...ranked.splice(index, 1));
    }

    const tried: string[] = [];
    let attempts = 0;
    let lastError: unknown;
    for (const entry of ranked) {
      if (attempts >= this.deps.maxAttempts) break;
      const key = modelKey(entry.candidate);
      // Uma falha nesta mesma chamada pode ter suspendido a fonte inteira (ex.: chave recusada):
      // pula sem gastar tentativa.
      if (this.deps.scores.cooldown(key)) continue;
      tried.push(key);
      const started = Date.now();
      try {
        const response = await this.providerFor(entry.candidate).chat(request);
        this.deps.scores.recordSuccess(ctx.task, key, Date.now() - started);
        ctx.pinned = key;
        if (ctx.task !== 'roteamento') {
          this.lastDecisions.set(ctx.userId, { task: ctx.task, model: key, reason: this.reason(entry, tried.length), at: new Date() });
        }
        this.logger.info(`🎯 ${ctx.task}/${ctx.privacy} → ${key} (nota ${entry.score.toFixed(2)}${entry.measured ? ', medida' : ', estimada'}, ${Date.now() - started}ms)`);
        return { ...response, providerName: key, model: entry.candidate.modelId };
      } catch (error) {
        lastError = error;
        // Chave recusada é instantânea e não diz nada sobre o modelo: não gasta o limite de tentativas.
        if (!(error instanceof LlmProviderError && error.isAuthError)) attempts++;
        this.handleFailure(ctx.task, entry.candidate, error);
      }
    }

    const reason = ranked.length === 0 ? 'nenhum modelo gratuito atende aos requisitos/privacidade' : `todas as tentativas falharam (${tried.join(', ')})`;
    this.logger.error(`Sem modelo disponível para ${ctx.task}/${ctx.privacy}: ${reason}`);
    throw new AllProvidersFailedError(tried.length ? tried : ['nenhum modelo gratuito disponível'], lastError);
  }

  async healthCheck(): Promise<void> {
    await this.refresh(true);
    if (this.deps.catalog.list().length === 0) throw new Error('Nenhum modelo gratuito disponível');
  }

  async healthCheckAll(): Promise<Array<{ name: string; ok: boolean; error?: unknown }>> {
    try {
      await this.refresh(true);
    } catch (error) {
      return [{ name: 'orquestrador', ok: false, error }];
    }
    return this.deps.catalog.sourceStatuses.map((s) => ({
      name: `${s.source} (${s.models} modelos)`,
      ok: s.enabled && s.models > 0,
      error: s.enabled ? (s.models > 0 ? undefined : new Error('nenhum modelo gratuito encontrado')) : new Error(s.reason),
    }));
  }

  /** Cota esgotada → cooldown crescente; chave inválida → fonte suspensa; modelo inexistente → 24 h. */
  private handleFailure(task: Task, candidate: ModelCandidate, error: unknown): void {
    const key = modelKey(candidate);
    const message = errorMessage(error);
    this.deps.scores.recordFailure(task, key);
    if (error instanceof LlmProviderError) {
      if (error.status === 429 || /quota|rate.?limit|exceeded/i.test(message)) {
        const daily = /per.?day|daily|quota/i.test(message);
        const ms = error.retryAfterMs ?? (daily ? OrchestratedLlmProvider.msUntilMidnight() : 10 * MINUTE);
        this.deps.scores.setCooldown(key, ms, 'cota esgotada');
        this.logger.warn(`⏸️ ${key}: cota esgotada, cooldown de ${Math.round(ms / MINUTE)} min`);
        return;
      }
      if (error.isAuthError) {
        for (const c of this.deps.catalog.list().filter((c) => c.source === candidate.source)) {
          this.deps.scores.setCooldown(modelKey(c), 60 * MINUTE, 'chave inválida');
        }
        const hint = candidate.source === 'ollama-cloud' ? ' — faça login com "ollama signin" para usar os modelos :cloud' : ' — confira a chave no .env';
        this.logger.error(`🔑 ${candidate.source}: autenticação recusada; fonte suspensa por 1 h${hint}`);
        return;
      }
      if (error.status === 404) {
        this.deps.scores.setCooldown(key, 24 * 60 * MINUTE, 'modelo indisponível');
        this.logger.warn(`❓ ${key}: modelo indisponível (404), suspenso por 24 h`);
        return;
      }
    }
    this.deps.scores.setCooldown(key, MINUTE, 'falha temporária');
    this.logger.warn(`⚠️ ${key} falhou (${message.slice(0, 120)}); tentando o próximo`);
  }

  private providerFor(candidate: ModelCandidate): ILlmProvider {
    const key = modelKey(candidate);
    let provider = this.providers.get(key);
    if (provider) return provider;
    if (this.deps.createProvider) {
      provider = this.deps.createProvider(candidate);
    } else {
      // Sem novas tentativas internas: em falha, trocar de modelo é melhor que esperar.
      const common = {
        apiKey: this.deps.catalog.apiKey(candidate.source, this.deps.keys.gemini, this.deps.keys.groq) ?? '',
        model: candidate.modelId,
        baseUrl: this.deps.catalog.baseUrl(candidate.source),
        temperature: this.deps.temperature,
        retryDelaysMs: [] as number[],
      };
      if (candidate.source === 'ollama' || candidate.source === 'ollama-cloud') {
        provider = new OllamaProvider({ ...common, timeoutMs: this.deps.ollamaTimeoutMs });
      } else if (candidate.source === 'gemini') {
        provider = new GeminiProvider({ ...common, timeoutMs: this.deps.timeoutMs, reasoningEffort: this.deps.geminiReasoningEffort });
      } else {
        provider = new OpenAICompatibleProvider({
          name: candidate.source,
          baseUrl: common.baseUrl,
          apiKey: common.apiKey,
          model: candidate.modelId,
          timeoutMs: this.deps.timeoutMs,
          defaultTemperature: common.temperature,
          retryDelaysMs: [],
        });
      }
    }
    this.providers.set(key, provider);
    return provider;
  }

  private reason(entry: RankedModel, attempt: number): string {
    const parts = [
      `nota ${entry.score.toFixed(2)} (${entry.measured ? 'medida por avaliação' : 'estimada pelos metadados'})`,
      entry.candidate.local ? 'roda na sua GPU' : `gratuito: ${entry.candidate.freeRule}`,
    ];
    if (attempt > 1) parts.push(`${attempt - 1} opção(ões) melhor(es) falharam ou estavam sem cota`);
    return parts.join('; ');
  }

  /** Requisitos da chamada: tools se houver ferramentas; contexto ≈ caracteres/4 + folga de saída. */
  static requirementsFor(request: LlmRequest): Requirements {
    const chars = request.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    return { tools: Boolean(request.tools?.length), vision: false, minContext: Math.ceil(chars / 4) + 2_048 };
  }

  static msUntilMidnight(now = new Date()): number {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 30, 0);
    return midnight.getTime() - now.getTime();
  }
}
