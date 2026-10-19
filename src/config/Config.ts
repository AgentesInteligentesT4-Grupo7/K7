import path from 'node:path';
import 'dotenv/config';

export type ProviderName = 'gemini' | 'deepseek' | 'groq' | 'ollama';
export type WhisperEngine = 'openai-whisper' | 'whisper-cpp' | 'http';
export type TtsEngine = 'kokoro' | 'edge';

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
  readonly telegramBotToken: string;
  readonly allowedUserIds: ReadonlySet<number>;

  readonly llmProvider: ProviderName;
  readonly llmFallbackProviders: ProviderName[];
  readonly skillRouterProvider: ProviderName | undefined;
  readonly llmTimeoutMs: number;
  readonly llmTemperature: number;
  readonly providers: Record<ProviderName, ProviderCredentials>;

  readonly maxIterations: number;
  readonly refinementMaxRounds: number;

  readonly dbPath: string;
  readonly memoryWindowSize: number;
  readonly maxMessageChars: number;

  readonly skillsDir: string;
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
  readonly voiceClone: { dir: string; baseUrl: string; language: string; defaultVoice: string | undefined; timeoutMs: number };
  readonly logLevel: string;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    rootDir: string = process.cwd(),
    /** O canal terminal não precisa do Telegram configurado. */
    options: { requireTelegram?: boolean } = {},
  ) {
    const requireTelegram = options.requireTelegram ?? true;
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
      groq: { apiKey: Config.optional(env.GROQ_API_KEY), model: env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile' },
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
    this.maxIterations = Config.positiveInt(env.MAX_ITERATIONS, 5);
    // Teto de rodadas das skills de refinamento (evita billing infinito por frontmatter mal escrito).
    this.refinementMaxRounds = Config.positiveInt(env.REFINEMENT_MAX_ROUNDS, 30);

    this.dbPath = path.resolve(rootDir, env.DB_PATH?.trim() || './data/parreiraclaw.db');
    this.memoryWindowSize = Config.positiveInt(env.MEMORY_WINDOW_SIZE, 20);
    this.maxMessageChars = Config.positiveInt(env.MAX_MESSAGE_CHARS, 100_000);

    this.skillsDir = path.resolve(rootDir, env.SKILLS_DIR?.trim() || './.agents/skills');
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
    this.voiceClone = {
      dir: path.resolve(rootDir, env.VOICE_CLONE_DIR?.trim() || './data/voices'),
      baseUrl: (env.CHATTERBOX_BASE_URL?.trim() || 'http://localhost:8004').replace(/\/+$/, ''),
      language: env.VOICE_CLONE_LANGUAGE?.trim() || 'pt',
      defaultVoice: Config.optional(env.VOICE_CLONE_DEFAULT),
      // Clonagem é mais pesada que o Kokoro: textos longos levam dezenas de segundos.
      timeoutMs: Config.positiveInt(env.VOICE_CLONE_TIMEOUT_MS, 180_000),
    };
    this.logLevel = env.LOG_LEVEL?.trim() || 'info';
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
