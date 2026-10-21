import fs from 'node:fs';
import path from 'node:path';
import type { OrchestratorConfig } from '../../config/Config.js';
import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import type { ProcessRunner } from '../../utils/ProcessRunner.js';
import type { FreeSourceId, ModelCandidate } from './types.js';

/** Entrada de modelo no catálogo models.dev (só os campos usados). */
interface CatalogModel {
  id: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  release_date?: string;
  modalities?: { input?: string[] };
  limit?: { context?: number };
  cost?: { input?: number; output?: number };
}
type Catalog = Record<string, { api?: string; models?: Record<string, CatalogModel> }>;

/** Fonte gratuita da nuvem: onde está no catálogo e qual regra define "gratuito". */
interface CloudSource {
  id: Exclude<FreeSourceId, 'ollama' | 'ollama-cloud'>;
  catalogKey: string;
  defaultBaseUrl: string;
  freeRule: string;
  isFree: (model: CatalogModel) => boolean;
}

const zeroCost = (m: CatalogModel) => m.cost?.input === 0 && m.cost?.output === 0;

export interface LocalModelInfo {
  name: string;
  remote: boolean;
  paramsB?: number;
  sizeBytes: number;
  toolCall: boolean;
  vision: boolean;
  completion: boolean;
  context: number;
}

export interface SourceStatus {
  source: FreeSourceId;
  enabled: boolean;
  reason: string;
  models: number;
}

/**
 * Descobre os modelos gratuitos disponíveis (RF-01, RF-03):
 * - nuvem: catálogo models.dev (cache local, renovado a cada N horas) filtrado pela regra de cada fonte;
 * - local: modelos instalados no Ollama, com capacidades (/api/show) e se cabem na VRAM.
 */
export class ModelCatalog {
  private readonly logger = new Logger('ModelCatalog');
  private catalog: Catalog | undefined;
  private candidates: ModelCandidate[] = [];
  private statuses: SourceStatus[] = [];
  private refreshedAt = 0;

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly ollamaBaseUrl: string,
    private readonly runner?: ProcessRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Fontes da nuvem e as regras de gratuidade (RF-01). Gemini/Groq: plano gratuito da conta do usuário. */
  private cloudSources(): CloudSource[] {
    const geminiFree = new Set(this.config.geminiFreeModels);
    const groqFree = new Set(this.config.groqFreeModels);
    return [
      {
        id: 'opencode',
        catalogKey: 'opencode',
        defaultBaseUrl: 'https://opencode.ai/zen/v1',
        freeRule: 'OpenCode Zen: modelos "-free", big-pickle e grok-code com custo zero',
        isFree: (m) => zeroCost(m) && (/-free$/.test(m.id) || ['big-pickle', 'grok-code'].includes(m.id)),
      },
      {
        id: 'openrouter',
        catalogKey: 'openrouter',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        freeRule: 'OpenRouter: modelos ":free"',
        isFree: (m) => m.id.endsWith(':free'),
      },
      {
        id: 'nvidia',
        catalogKey: 'nvidia',
        defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
        freeRule: 'NVIDIA build.nvidia.com: modelos com custo zero',
        isFree: zeroCost,
      },
      {
        id: 'gemini',
        catalogKey: 'google',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        freeRule: 'Gemini: modelos do plano gratuito da sua conta (GEMINI_FREE_MODELS)',
        isFree: (m) => geminiFree.has(m.id),
      },
      {
        id: 'groq',
        catalogKey: 'groq',
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        freeRule: 'Groq: modelos do plano gratuito da sua conta (GROQ_FREE_MODELS)',
        isFree: (m) => groqFree.has(m.id),
      },
    ];
  }

  get sourceStatuses(): SourceStatus[] {
    return this.statuses;
  }

  list(): ModelCandidate[] {
    return this.candidates;
  }

  /** URL base de uma fonte (OPENCODE_BASE_URL sobrescreve; senão catálogo; senão padrão). */
  baseUrl(source: FreeSourceId): string {
    if (source === 'ollama' || source === 'ollama-cloud') return this.ollamaBaseUrl;
    if (source === 'opencode' && this.config.opencode.baseUrl) return this.config.opencode.baseUrl.replace(/\/+$/, '');
    const def = this.cloudSources().find((s) => s.id === source)!;
    return (this.catalog?.[def.catalogKey]?.api ?? def.defaultBaseUrl).replace(/\/+$/, '');
  }

  apiKey(source: FreeSourceId, geminiKey?: string, groqKey?: string): string | undefined {
    switch (source) {
      case 'opencode':
        return this.config.opencode.apiKey;
      case 'openrouter':
        return this.config.openrouterApiKey;
      case 'nvidia':
        return this.config.nvidiaApiKey;
      case 'gemini':
        return geminiKey;
      case 'groq':
        return groqKey;
      default:
        return 'ollama';
    }
  }

  /** Recarrega catálogo + modelos locais. `keys` indica quais fontes da nuvem têm chave. */
  async refresh(keys: { gemini?: string; groq?: string }, force = false): Promise<void> {
    const maxAge = this.config.catalogRefreshHours * 3600_000;
    if (!force && this.candidates.length > 0 && Date.now() - this.refreshedAt < maxAge) return;

    this.catalog = await this.loadCatalog();
    const statuses: SourceStatus[] = [];
    const candidates: ModelCandidate[] = [];
    const enabledList = new Set(this.config.freeSources);
    const trains = new Set(this.config.sourcesTrainingOnData);

    for (const source of this.cloudSources()) {
      const key = this.apiKey(source.id, keys.gemini, keys.groq);
      const reason = !enabledList.has(source.id)
        ? 'fora de FREE_SOURCES'
        : source.id === 'opencode' && !this.config.opencode.enabled
          ? 'desligado (OPENCODE_ENABLED=false)'
          : !key
            ? 'sem chave de API no .env'
            : '';
      const models = reason ? [] : Object.values(this.catalog?.[source.catalogKey]?.models ?? {}).filter(source.isFree);
      for (const m of models) {
        candidates.push({
          source: source.id,
          modelId: m.id,
          name: m.name ?? m.id,
          local: false,
          toolCall: m.tool_call === true,
          vision: (m.modalities?.input ?? []).includes('image'),
          context: m.limit?.context ?? 0,
          trainsOnData: trains.has(source.id),
          releaseDate: m.release_date,
          reasoning: m.reasoning,
          freeRule: source.freeRule,
        });
      }
      statuses.push({ source: source.id, enabled: !reason, reason: reason || 'ok', models: models.length });
    }

    const localEnabled = enabledList.has('ollama');
    const cloudEnabled = enabledList.has('ollama-cloud');
    if (localEnabled || cloudEnabled) {
      const local = await this.loadOllamaModels();
      const vram = await this.gpuVramBytes();
      for (const m of local) {
        if (!m.completion) continue; // modelos só de embedding
        const source: FreeSourceId = m.remote ? 'ollama-cloud' : 'ollama';
        if ((source === 'ollama' && !localEnabled) || (source === 'ollama-cloud' && !cloudEnabled)) continue;
        candidates.push({
          source,
          modelId: m.name,
          name: m.name,
          local: !m.remote,
          toolCall: m.toolCall,
          vision: m.vision,
          context: m.context,
          trainsOnData: source === 'ollama-cloud' ? trains.has('ollama-cloud') : false,
          paramsB: m.paramsB,
          gpuFit: m.remote ? undefined : vram === undefined ? undefined : m.sizeBytes * 1.15 <= vram,
          freeRule: m.remote ? 'Ollama Cloud: plano gratuito da conta ollama.com' : 'Ollama local: roda nesta máquina',
        });
      }
      for (const [id, enabled] of [['ollama', localEnabled], ['ollama-cloud', cloudEnabled]] as const) {
        statuses.push({
          source: id,
          enabled,
          reason: enabled ? 'ok' : 'fora de FREE_SOURCES',
          models: candidates.filter((c) => c.source === id).length,
        });
      }
    }

    this.candidates = candidates;
    this.statuses = statuses;
    this.refreshedAt = Date.now();
    this.logger.info(
      `📚 Modelos gratuitos: ${candidates.length} (${statuses.filter((s) => s.enabled).map((s) => `${s.source}=${s.models}`).join(', ')})`,
    );
  }

  /** Lê o cache do models.dev; renova pela rede quando vencido. Sem rede, usa o cache antigo. */
  private async loadCatalog(): Promise<Catalog | undefined> {
    const cachePath = this.config.catalogCachePath;
    const fresh =
      fs.existsSync(cachePath) && Date.now() - fs.statSync(cachePath).mtimeMs < this.config.catalogRefreshHours * 3600_000;
    if (!fresh) {
      try {
        const response = await this.fetchImpl(this.config.catalogUrl, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        JSON.parse(text); // valida antes de sobrescrever o cache
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, text);
      } catch (error) {
        this.logger.warn(`Catálogo models.dev indisponível (${errorMessage(error)}); usando cache local`);
      }
    }
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Catalog;
    } catch {
      this.logger.warn('Sem catálogo models.dev: só modelos do Ollama ficam disponíveis');
      return undefined;
    }
  }

  private async loadOllamaModels(): Promise<LocalModelInfo[]> {
    const root = this.ollamaBaseUrl.replace(/\/v1\/?$/, '');
    try {
      const tags = (await (await this.fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(5_000) })).json()) as {
        models?: Array<{ name: string; size?: number; remote_model?: string; details?: { parameter_size?: string } }>;
      };
      const result: LocalModelInfo[] = [];
      for (const model of tags.models ?? []) {
        let capabilities: string[] = [];
        let context = 0;
        try {
          const show = (await (
            await this.fetchImpl(`${root}/api/show`, {
              method: 'POST',
              body: JSON.stringify({ model: model.name }),
              signal: AbortSignal.timeout(5_000),
            })
          ).json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
          capabilities = show.capabilities ?? [];
          const ctx = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith('.context_length'));
          context = typeof ctx?.[1] === 'number' ? ctx[1] : 0;
        } catch {
          // sem detalhes: o modelo entra com capacidades desconhecidas (sem tools)
        }
        result.push({
          name: model.name,
          remote: Boolean(model.remote_model) || /[:-]cloud$/.test(model.name),
          paramsB: ModelCatalog.parseParams(model.details?.parameter_size),
          sizeBytes: model.size ?? 0,
          toolCall: capabilities.includes('tools'),
          vision: capabilities.includes('vision'),
          completion: capabilities.length === 0 || capabilities.includes('completion'),
          context,
        });
      }
      return result;
    } catch (error) {
      this.logger.warn(`Ollama inacessível em ${root} (${errorMessage(error)}); sem modelos locais`);
      return [];
    }
  }

  /** VRAM total da GPU NVIDIA (bytes), ou undefined se não houver nvidia-smi. */
  private async gpuVramBytes(): Promise<number | undefined> {
    if (!this.runner) return undefined;
    try {
      const result = await this.runner.run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], 5_000);
      const mib = Number(result.stdout.split('\n')[0]?.trim());
      return Number.isFinite(mib) && mib > 0 ? mib * 1024 * 1024 : undefined;
    } catch {
      return undefined;
    }
  }

  /** "7.6B" → 7.6; "1T" → 1000; "466.65M" → 0.47. */
  static parseParams(value: string | undefined): number | undefined {
    const match = /^([\d.]+)\s*([KMBT])$/i.exec(value?.trim() ?? '');
    if (!match) return undefined;
    const n = Number(match[1]);
    const unit = match[2]!.toUpperCase();
    return unit === 'T' ? n * 1000 : unit === 'B' ? n : unit === 'M' ? n / 1000 : n / 1_000_000;
  }
}
