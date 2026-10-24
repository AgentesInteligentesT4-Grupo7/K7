import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { type AgentIdentity, identityFromEnv } from './AgentIdentity.js';
import { type ReasoningMode, parseMode } from '../agent/Reasoning.js';
import { DEFAULT_GUARDRAILS, type GuardrailsConfig, parseGuardrails } from '../guardrails/GuardrailsConfig.js';
import type { EmbeddingsChoice } from '../modules/conhecimento/Embeddings.js';
import type { RetrievalOptions } from '../modules/conhecimento/KnowledgeRetriever.js';
import { parseImageModels } from '../modules/imagens/ImageStyles.js';
import { CHANNELS, type ChannelId, DEFAULT_CHANNELS, DEFAULT_MODULES, MODULE_IDS, moduleSkillDirs } from '../modules/registry.js';

export type ProviderName = 'gemini' | 'deepseek' | 'groq' | 'ollama';
export type WhisperEngine = 'openai-whisper' | 'whisper-cpp' | 'http';
export type TtsEngine = 'kokoro' | 'edge';

export interface KnowledgeConfig {
  /** `conhecimento/` da fita (vem com ela). */
  dir: string;
  /** O que o usuário guarda pelo chat (nos dados do perfil, fora da fita). */
  userDir: string;
  embeddings: EmbeddingsChoice;
  ollamaModel: string;
  geminiModel: string;
  chunkSize: number;
  chunkOverlap: number;
  /** Busca em toda mensagem e põe os trechos no prompt (além da ferramenta). */
  auto: boolean;
  retrieval: RetrievalOptions;
}

export const SUPPORTED_TTS_ENGINES: readonly TtsEngine[] = ['kokoro', 'edge'];

export const SUPPORTED_PROVIDERS: readonly ProviderName[] = ['gemini', 'deepseek', 'groq', 'ollama'];

export interface ProviderCredentials {
  /** `undefined` = provider não configurado. Providers locais usam um valor fixo. */
  apiKey: string | undefined;
  model: string;
  baseUrl?: string;
  /** Timeout específico do provider (sobrescreve LLM_TIMEOUT_MS). */
  timeoutMs?: number;
  think?: boolean;
  maxTokens?: number;
  reasoningEffort?: string;
}

export interface OrchestratorConfig {
  /** LLM_ORCHESTRATOR=on ativa a escolha automática; off mantém a cadeia fixa do .env. */
  enabled: boolean;
  costPolicy: 'free-only';
  freeSources: string[];
  /** OpenCode Zen: OPENCODE_ENABLED liga/desliga os modelos gratuitos do Zen. */
  opencode: { enabled: boolean; apiKey: string | undefined; baseUrl: string | undefined };
  openrouterApiKey: string | undefined;
  nvidiaApiKey: string | undefined;
  /** Modelos cobertos pelo plano gratuito da sua conta (Gemini/Groq não marcam isso no catálogo). */
  geminiFreeModels: string[];
  groqFreeModels: string[];
  catalogUrl: string;
  catalogRefreshHours: number;
  catalogCachePath: string;
  privacyDefault: 'publico' | 'pessoal' | 'local';
  sourcesTrainingOnData: string[];
  maxAttempts: number;
  /** Modelos do Ollama preferidos para tarefas locais, em ordem (ORCHESTRATOR_LOCAL_PREFER). */
  localPreference: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Configuração central da aplicação, lida do `.env` uma única vez.
 * Valida o mínimo necessário para o bot subir e aplica defaults seguros.
 */
export class Config {
  /** Nome, dono e foco do agente (AGENT_NAME, OWNER_NAME, AGENT_PURPOSE...). */
  readonly identity: AgentIdentity;
  readonly telegramBotToken: string;
  readonly allowedUserIds: ReadonlySet<number>;

  readonly llmProvider: ProviderName;
  readonly llmFallbackProviders: ProviderName[];
  readonly skillRouterProvider: ProviderName | undefined;
  readonly llmTimeoutMs: number;
  readonly llmTemperature: number;
  readonly providers: Record<ProviderName, ProviderCredentials>;

  /** Orquestrador de LLMs gratuitos (spec llm-orchestration). */
  readonly orchestrator: OrchestratorConfig;

  readonly maxIterations: number;
  readonly refinementMaxRounds: number;

  readonly dbPath: string;
  readonly memoryWindowSize: number;
  /** Memória em camadas (spec memory v1.1); MEMORY_LAYERED=false volta à janela fixa da v1.0. */
  readonly memoryLayers: {
    enabled: boolean;
    recentMessages: number;
    summaryTrigger: number;
    summaryMaxChars: number;
    compactThreshold: number;
    tokenBudget: number;
    factsEnabled: boolean;
    summaryProvider: ProviderName | undefined;
  };
  readonly maxMessageChars: number;

  /** Pasta de skills do perfil/base (a última camada: sobrescreve as dos módulos). */
  readonly skillsDir: string;
  /** Camadas de skills: módulos ligados primeiro, depois a pasta do perfil/base (spec profiles-modules RF-08). */
  readonly skillsDirs: string[];
  /** Módulos ligados (MODULES); sem perfil, todos. */
  readonly modules: ReadonlySet<string>;
  /** Canais ligados (CHANNELS): telegram, terminal, web. */
  readonly channels: ReadonlySet<ChannelId>;
  /** Perfil ativo (definido pelo carregador de perfis), ou undefined no modo sem perfil. */
  readonly profileName: string | undefined;
  /** Personas (spec personas-styles): pasta da fita com `<nome>.md`. */
  readonly personasDir: string;
  /** Estilos de texto em camadas: tocador `estilos/` → fita (ESTILOS_DIR). */
  readonly stylesDirs: string[];
  /** Estilo usado quando nada mais escolhe um (ESTILO_PADRAO / estilo_padrao da fita). */
  readonly defaultStyle: string | undefined;
  /** Modo de raciocínio padrão (MODO_PADRAO / modo_padrao da fita). */
  readonly defaultMode: ReasoningMode | undefined;
  /** Guardrails da fita (bloco `guardrails:` do perfil.yaml, via GUARDRAILS em JSON). */
  readonly guardrails: GuardrailsConfig;
  /** Pasta do perfil em uso (evals/ e skills/ próprios). */
  readonly profileDir: string | undefined;
  /** Pasta das ferramentas HTTP declarativas (módulo "http"); com perfil, `<perfil>/ferramentas`. */
  readonly httpToolsDir: string | undefined;
  /** Ambiente efetivo (com perfil, já mesclado): de onde as ferramentas HTTP leem suas chaves. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tmpDir: string;
  readonly workspaceDir: string;

  readonly maxDocumentBytes: number;
  readonly maxDocumentChars: number;

  readonly whisperEngine: WhisperEngine;
  readonly whisperBin: string;
  /** Motor http: servidor compatível com OpenAI /audio/transcriptions. */
  readonly whisperBaseUrl: string;
  readonly whisperModel: string;
  readonly whisperLanguage: string;
  readonly whisperTimeoutMs: number;
  readonly ffmpegBin: string;

  /** Motores de TTS em ordem de preferência (o primeiro que funcionar é usado). */
  readonly ttsEngines: TtsEngine[];
  readonly ttsTimeoutMs: number;
  readonly kokoro: { baseUrl: string; voice: string; speed: number; langCode: string };
  /** Voz do Edge-TTS. */
  readonly ttsVoice: string;
  /** Clonagem de voz (Chatterbox na GPU) e pasta das amostras. */
  /** Canal web (chat no navegador): só em 127.0.0.1 por padrão, protegido por token. */
  readonly web: { host: string; port: number; token: string | undefined; userId: string };
  /** Módulo anexos (spec attachments): biblioteca ao lado do banco, isolada por perfil. */
  readonly attachments: { dir: string; retentionDays: number; maxBytes: number };
  /** Módulo conhecimento (spec knowledge-base): pastas, embeddings e técnicas de busca. */
  readonly knowledge: KnowledgeConfig;
  /** Módulo pesquisa-web (spec web-search). */
  readonly search: {
    providers: string[];
    searxngUrl: string;
    tavilyApiKey: string | undefined;
    timeoutMs: number;
    maxBytes: number;
    pageMaxChars: number;
    language: string;
    region: string;
  };
  /** Teto para o max_iterations que uma skill pode pedir no frontmatter (spec web-search RF-10). */
  readonly maxIterationsHardCap: number;
  /** Módulo imagens (spec image-generation): ComfyUI na GPU. */
  readonly images: {
    baseUrl: string;
    models: Record<string, string>;
    defaultStyle: string;
    quality: 'rapido' | 'qualidade';
    timeoutMs: number;
    idleUnloadMs: number;
    /** Versões geradas quando há personagem, para a inspeção escolher a melhor (IMAGE_CANDIDATES, até 4). */
    candidates: number;
    /** Libera a GPU (ComfyUI + Ollama) este tempo depois de entregar a imagem (IMAGE_RELEASE_AFTER_SEC; 0 = não). */
    releaseAfterMs: number;
    /** Pasta das imagens geradas (tmp/<perfil>/imagens) e quantas ficam (IMAGE_KEEP): a mais antiga sai primeiro. */
    dir: string;
    keep: number;
  };
  readonly voiceClone: {
    dir: string;
    baseUrl: string;
    language: string;
    defaultVoice: string | undefined;
    timeoutMs: number;
    /** VOICE_CLONE_VERIFY_TEXT: /minhavoz pede a leitura de um texto gerado pelo LLM local (padrão: ligado). */
    verifyText: boolean;
    /** VOICE_CLONE_VERIFY_MIN: parte mínima do texto que precisa ser lida (0,1–1; padrão 0,6). */
    verifyMin: number;
    /** VOICE_CLONE_DIRECTION: auto (LLM local dirige ritmo e pausas) | manual (só marcações) | off. */
    direction: 'auto' | 'manual' | 'off';
  };
  readonly logLevel: string;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    rootDir: string = process.cwd(),
    /** Padrão: exige o Telegram só se o canal estiver ligado em CHANNELS (o terminal passa false). */
    options: { requireTelegram?: boolean } = {},
  ) {
    this.channels = Config.parseSet(env.CHANNELS || DEFAULT_CHANNELS.join(','), CHANNELS, 'CHANNELS') as ReadonlySet<ChannelId>;
    const requireTelegram = options.requireTelegram ?? this.channels.has('telegram');
    this.identity = identityFromEnv(env);
    this.telegramBotToken = requireTelegram ? Config.required(env, 'TELEGRAM_BOT_TOKEN') : env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
    this.allowedUserIds = requireTelegram || env.TELEGRAM_ALLOWED_USER_IDS?.trim()
      ? Config.parseUserIds(Config.required(env, 'TELEGRAM_ALLOWED_USER_IDS'))
      : new Set<number>();

    this.llmProvider = Config.parseProvider(env.LLM_PROVIDER ?? 'gemini', 'LLM_PROVIDER');
    this.llmFallbackProviders = Config.list(env.LLM_FALLBACK_PROVIDERS)
      .map((name) => Config.parseProvider(name, 'LLM_FALLBACK_PROVIDERS'))
      .filter((name, index, all) => name !== this.llmProvider && all.indexOf(name) === index);
    this.skillRouterProvider = env.SKILL_ROUTER_PROVIDER?.trim()
      ? Config.parseProvider(env.SKILL_ROUTER_PROVIDER, 'SKILL_ROUTER_PROVIDER')
      : undefined;
    this.llmTimeoutMs = Config.positiveInt(env.LLM_TIMEOUT_MS, 120_000);
    this.llmTemperature = Config.number(env.LLM_TEMPERATURE, 0.4);

    this.providers = {
      gemini: {
        apiKey: Config.optional(env.GEMINI_API_KEY),
        model: env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash',
        // O Gemini 3 pensa bastante por padrão (~24s numa frase); 'low' responde em ~3s.
        reasoningEffort: env.GEMINI_REASONING_EFFORT === undefined ? 'low' : env.GEMINI_REASONING_EFFORT.trim(),
        // Com raciocínio 'low' as respostas levam 3–30s; acima disso o Gemini provavelmente travou (sobrecarga).
        timeoutMs: Config.positiveInt(env.GEMINI_TIMEOUT_MS, 60_000),
      },
      deepseek: { apiKey: Config.optional(env.DEEPSEEK_API_KEY), model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat' },
      groq: { apiKey: Config.optional(env.GROQ_API_KEY), model: env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b' },
      // Ollama roda localmente e não exige API key; inferência local costuma ser mais lenta.
      ollama: {
        apiKey: 'ollama',
        model: env.OLLAMA_MODEL?.trim() || 'qwen2.5:7b-instruct',
        baseUrl: (env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434/v1').replace(/\/+$/, ''),
        timeoutMs: Config.positiveInt(env.OLLAMA_TIMEOUT_MS, 300_000),
        think: Config.bool(env.OLLAMA_THINK, false),
        maxTokens: Config.positiveInt(env.OLLAMA_MAX_TOKENS, 4096),
      },
    };
    if (!this.providers[this.llmProvider].apiKey) {
      throw new ConfigError(`A API key do provider principal "${this.llmProvider}" não foi definida no .env.`);
    }

    // EC-03 (agent-loop): fallback explícito para 5 se MAX_ITERATIONS for nulo/inválido.
    this.orchestrator = Config.parseOrchestrator(env, rootDir, this.providers);
    this.maxIterations = Config.positiveInt(env.MAX_ITERATIONS, 5);
    // Teto de rodadas das skills de refinamento (evita billing infinito por frontmatter mal escrito).
    this.refinementMaxRounds = Config.positiveInt(env.REFINEMENT_MAX_ROUNDS, 30);

    this.dbPath = path.resolve(rootDir, env.DB_PATH?.trim() || Config.defaultDbPath(rootDir));
    this.memoryWindowSize = Config.positiveInt(env.MEMORY_WINDOW_SIZE, 20);
    this.memoryLayers = {
      enabled: Config.bool(env.MEMORY_LAYERED, true),
      recentMessages: Config.positiveInt(env.MEMORY_RECENT_MESSAGES, 8),
      summaryTrigger: Config.positiveInt(env.MEMORY_SUMMARY_TRIGGER, 10),
      summaryMaxChars: Config.positiveInt(env.MEMORY_SUMMARY_MAX_CHARS, 2_000),
      compactThreshold: Config.positiveInt(env.MEMORY_COMPACT_THRESHOLD, 2_000),
      tokenBudget: Config.positiveInt(env.MEMORY_TOKEN_BUDGET, 6_000),
      factsEnabled: Config.bool(env.USER_FACTS_ENABLED, true),
      summaryProvider: env.MEMORY_SUMMARY_PROVIDER?.trim() ? Config.parseProvider(env.MEMORY_SUMMARY_PROVIDER, 'MEMORY_SUMMARY_PROVIDER') : undefined,
    };
    this.maxMessageChars = Config.positiveInt(env.MAX_MESSAGE_CHARS, 100_000);

    this.skillsDir = path.resolve(rootDir, env.SKILLS_DIR?.trim() || './.agents/skills');
    this.modules = Config.parseSet(env.MODULES ?? DEFAULT_MODULES, MODULE_IDS, 'MODULES');
    this.skillsDirs = [...moduleSkillDirs(rootDir, this.modules), this.skillsDir];
    this.profileName = env.PERFIL_NOME?.trim() || undefined;
    this.personasDir = path.resolve(rootDir, env.PERSONAS_DIR?.trim() || './personas');
    this.stylesDirs = [path.resolve(rootDir, 'estilos'), ...(env.ESTILOS_DIR?.trim() ? [path.resolve(rootDir, env.ESTILOS_DIR.trim())] : [])];
    this.defaultStyle = env.ESTILO_PADRAO?.trim().toLowerCase() || undefined;
    this.guardrails = Config.parseGuardrails(env.GUARDRAILS);
    this.defaultMode = parseMode(env.MODO_PADRAO);
    if (env.MODO_PADRAO?.trim() && !this.defaultMode) throw new ConfigError('MODO_PADRAO deve ser normal, reformular ou verificado');
    this.profileDir = env.PERFIL_DIR?.trim() ? path.resolve(rootDir, env.PERFIL_DIR.trim()) : undefined;
    this.httpToolsDir = env.FERRAMENTAS_DIR?.trim() ? path.resolve(rootDir, env.FERRAMENTAS_DIR.trim()) : undefined;
    this.env = env;
    this.tmpDir = path.resolve(rootDir, env.TMP_DIR?.trim() || './tmp');
    this.workspaceDir = path.resolve(rootDir, env.WORKSPACE_DIR?.trim() || './workspace');

    this.maxDocumentBytes = Config.positiveInt(env.MAX_DOCUMENT_MB, 20) * 1024 * 1024;
    this.maxDocumentChars = Config.positiveInt(env.MAX_DOCUMENT_CHARS, 100_000);

    const engine = env.WHISPER_ENGINE?.trim() || 'openai-whisper';
    if (engine !== 'openai-whisper' && engine !== 'whisper-cpp' && engine !== 'http') {
      throw new ConfigError(`WHISPER_ENGINE inválido: "${engine}". Use http, openai-whisper ou whisper-cpp.`);
    }
    this.whisperEngine = engine;
    this.whisperBin = env.WHISPER_BIN?.trim() || (engine === 'whisper-cpp' ? 'whisper-cli' : 'whisper');
    this.whisperBaseUrl = (env.WHISPER_BASE_URL?.trim() || 'http://localhost:8890/v1').replace(/\/+$/, '');
    this.whisperModel = env.WHISPER_MODEL?.trim() || (engine === 'http' ? 'deepdml/faster-whisper-large-v3-turbo-ct2' : 'base');
    this.whisperLanguage = env.WHISPER_LANGUAGE?.trim() || 'pt';
    this.whisperTimeoutMs = Config.positiveInt(env.WHISPER_TIMEOUT_MS, 60_000);
    this.ffmpegBin = env.FFMPEG_BIN?.trim() || 'ffmpeg';

    this.ttsEngines = Config.list(env.TTS_ENGINES || 'kokoro').map((name) => {
      const engine = name.toLowerCase();
      if (!SUPPORTED_TTS_ENGINES.includes(engine as TtsEngine)) {
        throw new ConfigError(`TTS_ENGINES inválido: "${name}". Suportados: ${SUPPORTED_TTS_ENGINES.join(', ')}`);
      }
      return engine as TtsEngine;
    });
    this.ttsTimeoutMs = Config.positiveInt(env.TTS_TIMEOUT_MS, 25_000);
    this.kokoro = {
      baseUrl: (env.KOKORO_BASE_URL?.trim() || 'http://localhost:8880/v1').replace(/\/+$/, ''),
      voice: env.KOKORO_VOICE?.trim() || 'pf_dora',
      speed: Config.number(env.KOKORO_SPEED, 1.0),
      langCode: env.KOKORO_LANG?.trim() || 'p',
    };
    this.ttsVoice = env.TTS_VOICE?.trim() || 'pt-BR-ThalitaMultilingualNeural';
    this.attachments = {
      dir: path.resolve(rootDir, env.ATTACHMENTS_DIR?.trim() || path.join(path.dirname(this.dbPath), 'anexos')),
      retentionDays: Config.positiveInt(env.ATTACHMENTS_RETENTION_DAYS, 90),
      maxBytes: Config.positiveInt(env.ATTACHMENTS_MAX_GB, 5) * 1024 ** 3,
    };
    this.knowledge = Config.parseKnowledge(env, rootDir, path.dirname(this.dbPath));
    this.search = {
      providers: Config.list(env.SEARCH_PROVIDERS || 'searxng,duckduckgo,tavily').map((p) => p.toLowerCase()),
      searxngUrl: (env.SEARXNG_BASE_URL?.trim() || 'http://localhost:8888').replace(/\/+$/, ''),
      tavilyApiKey: Config.optional(env.TAVILY_API_KEY),
      timeoutMs: Config.positiveInt(env.WEB_FETCH_TIMEOUT_MS, 10_000),
      maxBytes: Config.positiveInt(env.WEB_FETCH_MAX_BYTES, 3 * 1024 * 1024),
      pageMaxChars: Config.positiveInt(env.WEB_PAGE_MAX_CHARS, 12_000),
      language: env.NEWS_LANGUAGE?.trim() || 'pt-BR',
      region: env.NEWS_REGION?.trim() || 'BR',
    };
    this.maxIterationsHardCap = Math.max(this.maxIterations, Config.positiveInt(env.MAX_ITERATIONS_HARD_CAP, 10));
    const quality = (env.IMAGE_QUALITY?.trim().toLowerCase() || 'rapido') as 'rapido' | 'qualidade';
    if (quality !== 'rapido' && quality !== 'qualidade') throw new ConfigError('IMAGE_QUALITY deve ser rapido ou qualidade');
    this.images = {
      baseUrl: (env.COMFYUI_BASE_URL?.trim() || 'http://localhost:8188').replace(/\/+$/, ''),
      models: parseImageModels(env.IMAGE_MODELS),
      defaultStyle: env.IMAGE_DEFAULT_STYLE?.trim().toLowerCase() || 'hq',
      quality,
      timeoutMs: Config.positiveInt(env.IMAGE_TIMEOUT_MS, 300_000),
      idleUnloadMs: Number(env.IMAGE_IDLE_UNLOAD_MIN ?? 2) * 60_000 || 0,
      candidates: Math.min(4, Config.positiveInt(env.IMAGE_CANDIDATES, 3)),
      // 0 desliga; padrão 10 s depois de entregar a resposta com imagem.
      releaseAfterMs: Number(env.IMAGE_RELEASE_AFTER_SEC ?? 10) * 1000 || 0,
      dir: path.join(this.tmpDir, 'imagens'),
      keep: Config.positiveInt(env.IMAGE_KEEP, 10),
    };
    this.web = {
      host: env.WEB_HOST?.trim() || '127.0.0.1',
      port: Config.positiveInt(env.WEB_PORT, 8787),
      token: env.WEB_TOKEN?.trim() || undefined,
      userId: env.WEB_USER_ID?.trim() || 'web',
    };
    this.voiceClone = {
      dir: path.resolve(rootDir, env.VOICE_CLONE_DIR?.trim() || './data/voices'),
      baseUrl: (env.CHATTERBOX_BASE_URL?.trim() || 'http://localhost:8004').replace(/\/+$/, ''),
      language: env.VOICE_CLONE_LANGUAGE?.trim() || 'pt',
      defaultVoice: Config.optional(env.VOICE_CLONE_DEFAULT),
      // Clonagem é mais pesada que o Kokoro: textos longos levam dezenas de segundos.
      timeoutMs: Config.positiveInt(env.VOICE_CLONE_TIMEOUT_MS, 180_000),
      // Cadastro só com leitura de um texto gerado na hora (garante que a voz é de quem grava).
      verifyText: Config.bool(env.VOICE_CLONE_VERIFY_TEXT, true),
      verifyMin: Math.min(1, Math.max(0.1, Number(env.VOICE_CLONE_VERIFY_MIN ?? 0.6) || 0.6)),
      direction: Config.speechDirection(env.VOICE_CLONE_DIRECTION),
    };
    this.logLevel = env.LOG_LEVEL?.trim() || 'info';
  }

  /** `data/k7.db`; instalações de antes da troca de nome continuam no `data/parreiraclaw.db` que já existe. */
  private static defaultDbPath(rootDir: string): string {
    const legacy = './data/parreiraclaw.db';
    return fs.existsSync(path.resolve(rootDir, legacy)) ? legacy : './data/k7.db';
  }

  private static speechDirection(raw: string | undefined): 'auto' | 'manual' | 'off' {
    const value = raw?.trim().toLowerCase();
    if (!value) return 'auto';
    if (value === 'auto' || value === 'manual' || value === 'off') return value;
    throw new ConfigError(`VOICE_CLONE_DIRECTION inválido: "${raw}" (use auto, manual ou off)`);
  }

  private static required(env: NodeJS.ProcessEnv, key: string): string {
    const value = env[key]?.trim();
    if (!value) throw new ConfigError(`Variável obrigatória ausente no .env: ${key}`);
    return value;
  }

  private static optional(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private static parseOrchestrator(
    env: NodeJS.ProcessEnv,
    rootDir: string,
    providers: Record<ProviderName, ProviderCredentials>,
  ): OrchestratorConfig {
    const privacy = (env.PRIVACY_DEFAULT?.trim() || 'publico') as OrchestratorConfig['privacyDefault'];
    if (!['publico', 'pessoal', 'local'].includes(privacy)) {
      throw new ConfigError(`PRIVACY_DEFAULT inválido: "${privacy}". Use publico, pessoal ou local.`);
    }
    const policy = env.LLM_COST_POLICY?.trim() || 'free-only';
    if (policy !== 'free-only') {
      throw new ConfigError(`LLM_COST_POLICY="${policy}" não é suportado: este projeto só usa modelos gratuitos (free-only).`);
    }
    return {
      enabled: Config.bool(env.LLM_ORCHESTRATOR, false),
      costPolicy: 'free-only',
      freeSources: Config.list(env.FREE_SOURCES || 'opencode,openrouter,nvidia,gemini,groq,ollama,ollama-cloud').map((s) => s.toLowerCase()),
      opencode: {
        enabled: Config.bool(env.OPENCODE_ENABLED, false),
        apiKey: Config.optional(env.OPENCODE_API_KEY),
        baseUrl: Config.optional(env.OPENCODE_BASE_URL),
      },
      openrouterApiKey: Config.optional(env.OPENROUTER_API_KEY),
      nvidiaApiKey: Config.optional(env.NVIDIA_API_KEY),
      geminiFreeModels: Config.list(env.GEMINI_FREE_MODELS || providers.gemini.model),
      groqFreeModels: Config.list(env.GROQ_FREE_MODELS || providers.groq.model),
      catalogUrl: env.MODELS_CATALOG_URL?.trim() || 'https://models.dev/api.json',
      catalogRefreshHours: Config.positiveInt(env.MODELS_CATALOG_REFRESH_HOURS, 24),
      catalogCachePath: path.resolve(rootDir, env.MODELS_CATALOG_CACHE?.trim() || './data/cache/models-dev.json'),
      privacyDefault: privacy,
      // Planos gratuitos que declaram (ou não descartam) usar os dados para treino.
      sourcesTrainingOnData: Config.list(env.SOURCES_TRAINING_ON_DATA || 'opencode,openrouter,nvidia,gemini,ollama-cloud').map((s) => s.toLowerCase()),
      maxAttempts: Config.positiveInt(env.ORCHESTRATOR_MAX_ATTEMPTS, 4),
      localPreference: Config.list(env.ORCHESTRATOR_LOCAL_PREFER ?? '').map((s) => s.toLowerCase()),
    };
  }

  /** Lista separada por vírgulas, validada contra os valores conhecidos. */
  /**
   * Opções do módulo conhecimento: `modulos.conhecimento` do perfil.yaml (via MODULOS_OPCOES) e,
   * por baixo, as variáveis do .env (EMBEDDINGS_PROVIDER, CONHECIMENTO_*).
   */
  private static parseKnowledge(env: NodeJS.ProcessEnv, rootDir: string, dataDir: string): KnowledgeConfig {
    let options: Record<string, unknown> = {};
    try {
      const all = env.MODULOS_OPCOES ? (JSON.parse(env.MODULOS_OPCOES) as Record<string, unknown>) : {};
      if (all.conhecimento && typeof all.conhecimento === 'object') options = all.conhecimento as Record<string, unknown>;
    } catch {
      throw new ConfigError('MODULOS_OPCOES deve ser JSON');
    }
    const pick = (key: string, envKey: string) => (options[key] !== undefined ? String(options[key]) : env[envKey]);
    // YAML lê "off" como false.
    const raw = pick('embeddings', 'EMBEDDINGS_PROVIDER')?.trim().toLowerCase() || 'auto';
    const embeddings = (raw === 'false' ? 'off' : raw) as EmbeddingsChoice;
    if (!['auto', 'ollama', 'gemini', 'off'].includes(embeddings)) throw new ConfigError('embeddings (EMBEDDINGS_PROVIDER) deve ser auto, ollama, gemini ou off');
    const fusion = pick('fusao', 'CONHECIMENTO_FUSAO');
    return {
      dir: path.resolve(rootDir, env.CONHECIMENTO_DIR?.trim() || './conhecimento'),
      userDir: path.resolve(rootDir, env.CONHECIMENTO_USUARIO_DIR?.trim() || path.join(dataDir, 'conhecimento')),
      embeddings,
      ollamaModel: env.OLLAMA_EMBED_MODEL?.trim() || 'embeddinggemma',
      geminiModel: env.GEMINI_EMBED_MODEL?.trim() || 'gemini-embedding-001',
      chunkSize: Config.positiveInt(pick('trecho', 'CONHECIMENTO_TRECHO'), 900),
      chunkOverlap: Config.positiveInt(pick('sobreposicao', 'CONHECIMENTO_SOBREPOSICAO'), 150),
      auto: Config.bool(pick('automatico', 'CONHECIMENTO_AUTOMATICO'), false),
      retrieval: {
        results: Config.positiveInt(pick('resultados', 'CONHECIMENTO_RESULTADOS'), 5),
        // "fusao: true" = 3 variações; número = quantas.
        fusion: fusion === 'true' ? 3 : Math.max(0, Math.min(5, Number(fusion) || 0)),
        hyde: Config.bool(pick('hyde', 'CONHECIMENTO_HYDE'), false),
        crag: Config.bool(pick('crag', 'CONHECIMENTO_CRAG'), false),
        adaptive: Config.bool(pick('adaptativo', 'CONHECIMENTO_ADAPTATIVO'), false),
      },
    };
  }

  /** GUARDRAILS: JSON com o bloco `guardrails:` do perfil (validado de novo para o modo sem perfil). */
  private static parseGuardrails(value: string | undefined): GuardrailsConfig {
    if (!value?.trim()) return DEFAULT_GUARDRAILS;
    let raw: unknown;
    try {
      raw = JSON.parse(value);
    } catch {
      throw new ConfigError('GUARDRAILS deve ser JSON (com perfil, declare o bloco guardrails: no perfil.yaml).');
    }
    return parseGuardrails(raw, (field, problem) => {
      throw new ConfigError(`GUARDRAILS: campo "${field}" ${problem}`);
    });
  }

  private static parseSet(value: string, known: readonly string[], key: string): ReadonlySet<string> {
    const items = Config.list(value).map((v) => v.toLowerCase());
    const unknown = items.filter((v) => !known.includes(v));
    if (unknown.length) throw new ConfigError(`${key} tem valores desconhecidos: ${unknown.join(', ')}. Disponíveis: ${known.join(', ')}`);
    return new Set(items);
  }

  private static list(value: string | undefined): string[] {
    return (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private static parseUserIds(raw: string): Set<number> {
    const ids = Config.list(raw).map((item) => {
      const id = Number(item);
      if (!Number.isSafeInteger(id)) throw new ConfigError(`TELEGRAM_ALLOWED_USER_IDS contém ID inválido: "${item}"`);
      return id;
    });
    if (ids.length === 0) throw new ConfigError('TELEGRAM_ALLOWED_USER_IDS precisa de pelo menos um ID.');
    return new Set(ids);
  }

  private static parseProvider(raw: string, key: string): ProviderName {
    const name = raw.trim().toLowerCase();
    if (!SUPPORTED_PROVIDERS.includes(name as ProviderName)) {
      throw new ConfigError(`${key} inválido: "${raw}". Suportados: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }
    return name as ProviderName;
  }

  static positiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  static bool(value: string | undefined, fallback: boolean): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return fallback;
    return ['1', 'true', 'yes', 'sim', 'on'].includes(normalized);
  }

  private static number(value: string | undefined, fallback: number): number {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
