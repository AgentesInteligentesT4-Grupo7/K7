import fs from 'node:fs';
import path from 'node:path';
import { AgentController } from '../agent/AgentController.js';
import { AgentLoop } from '../agent/AgentLoop.js';
import { SystemPromptBuilder } from '../agent/SystemPromptBuilder.js';
import type { IOutputHandler } from '../agent/types.js';
import type { Config } from '../config/Config.js';
import { LlmProviderError, errorMessage } from '../errors/AppErrors.js';
import { type Orchestrator, createOrchestrator } from '../llm/orchestration/createOrchestrator.js';
import type { ILlmProvider } from '../llm/types.js';
import { ProviderFactory } from '../llm/ProviderFactory.js';
import { DatabaseConnection } from '../memory/DatabaseConnection.js';
import { DatabaseMaintenance } from '../memory/DatabaseMaintenance.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { SkillExecutor } from '../skills/SkillExecutor.js';
import { SkillLoader } from '../skills/SkillLoader.js';
import { SkillRouter } from '../skills/SkillRouter.js';
import { DocumentExtractor } from '../telegram/input/DocumentExtractor.js';
import { WhisperHttpTranscriber } from '../telegram/input/WhisperHttpTranscriber.js';
import { type ISpeechToText, WhisperTranscriber } from '../telegram/input/WhisperTranscriber.js';
import { EdgeTtsSynthesizer } from '../telegram/output/tts/EdgeTtsSynthesizer.js';
import { KokoroTtsSynthesizer } from '../telegram/output/tts/KokoroTtsSynthesizer.js';
import { FallbackTextToSpeech, type ITextToSpeech } from '../telegram/output/tts/TextToSpeech.js';
import { ListClonedVoicesTool } from '../tools/impl/ListClonedVoicesTool.js';
import { ToolFactory } from '../tools/ToolFactory.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { FfmpegConverter } from '../utils/FfmpegConverter.js';
import { Logger } from '../utils/Logger.js';
import { ProcessRunner } from '../utils/ProcessRunner.js';
import { TempFileManager } from '../utils/TempFileManager.js';
import { AudioSampleConverter } from '../voice/AudioSampleConverter.js';
import { ChatterboxVoiceCloner } from '../voice/ChatterboxVoiceCloner.js';
import { VoiceCloneService } from '../voice/VoiceCloneService.js';
import { VoiceLibrary } from '../voice/VoiceLibrary.js';

export interface CoreOptions {
  /** Pasta temporária deste processo (o terminal usa uma própria para não colidir com o bot). */
  tmpDir: string;
  /** Limpa a pasta temporária no startup (só o processo dono dela deve fazer isso). */
  cleanTmp: boolean;
  /** Backup diário e VACUUM do SQLite (só o processo principal, o bot). */
  databaseMaintenance: boolean;
  /** Health checks de LLM, TTS, STT e clonagem no startup (com logs). */
  healthChecks: boolean;
}

/** Núcleo do agente, independente de canal (Telegram, terminal, futuro HTTP/WhatsApp). */
/** Cadeia de LLMs usada pelo agente: fixa (FallbackLlmProvider) ou automática (orquestrador). */
export type LlmChain = ILlmProvider & {
  providerNames: string[];
  healthCheckAll(): Promise<Array<{ name: string; ok: boolean; error?: unknown }>>;
};

export interface Core {
  config: Config;
  tmp: TempFileManager;
  memory: MemoryManager;
  llm: LlmChain;
  /** Presente quando LLM_ORCHESTRATOR=on (comandos /modelos, /modelo, /bom, /ruim). */
  orchestrator?: Orchestrator;
  registry: ToolRegistry;
  skillLoader: SkillLoader;
  tts: FallbackTextToSpeech;
  stt: ISpeechToText;
  ffmpeg: FfmpegConverter;
  voiceClone: VoiceCloneService;
  documents: DocumentExtractor;
  /** Cria o Facade ligado ao `IOutputHandler` do canal. */
  createController(output: IOutputHandler): AgentController;
}

const logger = new Logger('Core');

export function createCore(config: Config, options: CoreOptions): Core {
  // Infra local
  const tmp = new TempFileManager(options.tmpDir);
  if (options.cleanTmp) tmp.initialize();
  else fs.mkdirSync(options.tmpDir, { recursive: true });
  fs.mkdirSync(config.skillsDir, { recursive: true });
  const db = DatabaseConnection.getInstance(config.dbPath);
  if (options.databaseMaintenance) {
    new DatabaseMaintenance(db, {
      backupDir: path.join(path.dirname(config.dbPath), 'backups'),
      keepBackups: 7,
      vacuumFreeRatio: 0.2,
      intervalMs: 24 * 60 * 60 * 1000,
    }).start();
  }
  const memory = new MemoryManager(db, { windowSize: config.memoryWindowSize, maxMessageChars: config.maxMessageChars });
  const runner = new ProcessRunner();
  const ffmpeg = new FfmpegConverter(config.ffmpegBin, runner);

  // Cérebros (LLM)
  const providerFactory = new ProviderFactory(config);
  // LLM_ORCHESTRATOR=on: escolha automática entre modelos gratuitos; off: cadeia fixa do .env.
  const orchestrator = config.orchestrator.enabled ? createOrchestrator(config, db, runner) : undefined;
  const llm: LlmChain = orchestrator?.provider ?? providerFactory.createWithFallback();
  const routerLlm: LlmChain =
    orchestrator?.provider ?? (config.skillRouterProvider ? providerFactory.createWithFallback(config.skillRouterProvider) : llm);
  logger.info(`🧠 LLM: ${llm.providerNames.join(' → ')} | Router: ${routerLlm.providerNames.join(' → ')}`);

  // Clonagem de voz (Chatterbox na GPU); amostras em VOICE_CLONE_DIR
  fs.mkdirSync(config.voiceClone.dir, { recursive: true });
  const voiceClone = new VoiceCloneService(
    new VoiceLibrary({ dir: config.voiceClone.dir, defaultVoice: config.voiceClone.defaultVoice }, new AudioSampleConverter()),
    new ChatterboxVoiceCloner(config.voiceClone),
  );
  logger.info(`🗣️ Clonagem de voz: ${voiceClone.list().length} voz(es) em ${path.relative(process.cwd(), config.voiceClone.dir) || config.voiceClone.dir}`);

  // Ferramentas, ReAct e skills
  const registry = new ToolFactory(config.workspaceDir).createRegistry();
  registry.register(new ListClonedVoicesTool(voiceClone, config.voiceClone.defaultVoice));
  const agentLoop = new AgentLoop(llm, registry, config.maxIterations);
  const skillLoader = new SkillLoader(config.skillsDir, config.identity);
  const skillRouter = new SkillRouter(routerLlm);
  const skillExecutor = new SkillExecutor(skillLoader, new SystemPromptBuilder(registry, config.identity), agentLoop, {
    roleProviders: providerFactory,
    maxRefinementRounds: config.refinementMaxRounds,
  });
  const skills = skillLoader.loadAll();
  logger.info(`🔧 ${registry.size} ferramentas | 📚 ${skills.length} skills: ${skills.map((s) => s.name).join(', ') || '(nenhuma)'}`);

  // Voz
  const tts = createTextToSpeech(config);
  logger.info(`🔊 TTS: ${tts.name} (voz ${tts.voice})`);
  const stt = createSpeechToText(config, runner, ffmpeg, tmp);
  logger.info(`🎙️ STT: whisper ${config.whisperEngine} (modelo ${config.whisperModel})`);

  if (options.healthChecks) {
    void checkProviders(llm);
    void checkVoiceClone(voiceClone);
    void checkTts(tts);
    void checkStt(stt, config.whisperEngine);
  }

  return {
    config,
    tmp,
    memory,
    llm,
    orchestrator,
    registry,
    skillLoader,
    tts,
    stt,
    ffmpeg,
    voiceClone,
    documents: new DocumentExtractor(),
    createController: (output) =>
      new AgentController({
        memory,
        skillLoader,
        skillRouter,
        skillExecutor,
        output,
        providerName: llm.name,
        privacyDefault: config.orchestrator.privacyDefault,
      }),
  };
}

/** Monta a cadeia de TTS conforme TTS_ENGINES (ex.: kokoro na GPU → edge na nuvem). */
function createTextToSpeech(config: Config): FallbackTextToSpeech {
  const engines: ITextToSpeech[] = config.ttsEngines.map((engine) =>
    engine === 'kokoro'
      ? new KokoroTtsSynthesizer({ ...config.kokoro, timeoutMs: config.ttsTimeoutMs })
      : new EdgeTtsSynthesizer(config.ttsVoice, config.ttsTimeoutMs),
  );
  return new FallbackTextToSpeech(engines);
}

/** WHISPER_ENGINE=http usa o container faster-whisper na GPU; os demais, processo local. */
function createSpeechToText(config: Config, runner: ProcessRunner, ffmpeg: FfmpegConverter, tmp: TempFileManager): ISpeechToText {
  if (config.whisperEngine === 'http') {
    return new WhisperHttpTranscriber({
      baseUrl: config.whisperBaseUrl,
      model: config.whisperModel,
      language: config.whisperLanguage,
      timeoutMs: config.whisperTimeoutMs,
    });
  }
  return new WhisperTranscriber(
    {
      engine: config.whisperEngine,
      bin: config.whisperBin,
      model: config.whisperModel,
      language: config.whisperLanguage,
      timeoutMs: config.whisperTimeoutMs,
    },
    runner,
    ffmpeg,
    tmp,
  );
}

/** EC-03 (PRD): loga falha de autenticação por provider sem impedir o startup. */
async function checkProviders(llm: LlmChain): Promise<void> {
  for (const result of await llm.healthCheckAll()) {
    if (result.ok) {
      logger.info(`✅ Provider ${result.name} autenticado`);
    } else if (result.error instanceof LlmProviderError && result.error.isAuthError) {
      logger.error(`❌ Erro fatal de autenticação no provider ${result.name}: verifique a API key no .env`);
    } else {
      logger.warn(`⚠️ Provider ${result.name} falhou no health check: ${errorMessage(result.error)}`);
    }
  }
}

async function checkStt(stt: ISpeechToText, engine: string): Promise<void> {
  if (!stt.healthCheck) return;
  try {
    await stt.healthCheck();
    logger.info(`✅ STT whisper ${engine} pronto`);
  } catch (error) {
    logger.warn(`⚠️ STT whisper ${engine} indisponível: ${errorMessage(error)}`);
  }
}

async function checkVoiceClone(service: VoiceCloneService): Promise<void> {
  try {
    await service.healthCheck();
    logger.info('✅ Clonagem de voz (Chatterbox) pronta');
  } catch (error) {
    logger.warn(`⚠️ Clonagem de voz indisponível: ${errorMessage(error)}`);
  }
}

async function checkTts(tts: FallbackTextToSpeech): Promise<void> {
  for (const result of await tts.healthCheckAll()) {
    if (result.ok) logger.info(`✅ TTS ${result.name} pronto`);
    else logger.warn(`⚠️ TTS ${result.name} indisponível: ${errorMessage(result.error)}`);
  }
}
