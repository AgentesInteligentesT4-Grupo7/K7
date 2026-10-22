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
import { loadHttpTools } from '../modules/http/loadHttpTools.js';
import { createWebTools } from '../modules/pesquisa-web/createWebTools.js';
import { AttachmentService } from '../modules/anexos/AttachmentService.js';
import { AttachmentStore } from '../modules/anexos/AttachmentStore.js';
import { createAttachmentTools } from '../modules/anexos/AttachmentTools.js';
import { ComfyUIClient } from '../modules/imagens/ComfyUIClient.js';
import { GenerateImageTool } from '../modules/imagens/GenerateImageTool.js';
import { ImageGenerator } from '../modules/imagens/ImageGenerator.js';
import { SkillExecutor } from '../skills/SkillExecutor.js';
import { SkillLoader } from '../skills/SkillLoader.js';
import { SkillRouter } from '../skills/SkillRouter.js';
import { DocumentExtractor } from '../documents/DocumentExtractor.js';
import { WhisperHttpTranscriber } from '../voice/stt/WhisperHttpTranscriber.js';
import { DisabledSpeechToText } from '../voice/stt/DisabledSpeechToText.js';
import { type ISpeechToText, WhisperTranscriber } from '../voice/stt/WhisperTranscriber.js';
import { EdgeTtsSynthesizer } from '../voice/tts/EdgeTtsSynthesizer.js';
import { KokoroTtsSynthesizer } from '../voice/tts/KokoroTtsSynthesizer.js';
import { FallbackTextToSpeech, type ITextToSpeech } from '../voice/tts/TextToSpeech.js';
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
  /** Ausente quando o módulo "voz-clonada" está desligado. */
  voiceClone?: VoiceCloneService;
  /** Ausente quando o módulo "anexos" está desligado (imagens são recusadas e documentos vão inteiros). */
  attachments?: AttachmentService;
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
  const { modules } = config;
  logger.info(`🧩 Módulos: ${[...modules].join(', ') || '(nenhum)'}${config.profileName ? ` | perfil: ${config.profileName}` : ''}`);
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

  // Módulo voz-clonada (Chatterbox na GPU); amostras em VOICE_CLONE_DIR
  const voiceClone = modules.has('voz-clonada') ? createVoiceClone(config) : undefined;

  // Ferramentas, ReAct e skills (camadas: módulos ligados → perfil)
  const registry = new ToolFactory(config.workspaceDir, { files: modules.has('arquivos') }).createRegistry();
  if (voiceClone) registry.register(new ListClonedVoicesTool(voiceClone, config.voiceClone.defaultVoice));
  if (modules.has('pesquisa-web')) for (const tool of createWebTools(config)) registry.register(tool);
  // Módulo anexos: biblioteca ao lado do banco do perfil; a retenção roda só no processo principal (o bot).
  const attachments = modules.has('anexos') ? new AttachmentService(new AttachmentStore(db, config.attachments.dir), llm) : undefined;
  if (attachments) {
    for (const tool of createAttachmentTools(attachments)) registry.register(tool);
    if (options.databaseMaintenance) {
      const removed = attachments.store.cleanup(config.attachments.retentionDays, config.attachments.maxBytes);
      if (removed) logger.info(`🧹 Anexos: ${removed} removido(s) pela retenção`);
    }
  }
  const images = modules.has('imagens') ? createImageGenerator(config) : undefined;
  if (images) registry.register(new GenerateImageTool(images, config.workspaceDir));
  if (modules.has('http') && config.httpToolsDir) {
    const reserved = new Set(registry.list().map((t) => t.name));
    for (const tool of loadHttpTools(config.httpToolsDir, config.env, reserved)) registry.register(tool);
  }
  const agentLoop = new AgentLoop(llm, registry, config.maxIterations);
  const skillLoader = new SkillLoader(config.skillsDirs, config.identity);
  const skillRouter = new SkillRouter(routerLlm);
  const skillExecutor = new SkillExecutor(skillLoader, new SystemPromptBuilder(registry, config.identity), agentLoop, {
    roleProviders: providerFactory,
    maxRefinementRounds: config.refinementMaxRounds,
    maxIterationsHardCap: config.maxIterationsHardCap,
  });
  const skills = skillLoader.loadAll();
  logger.info(`🔧 ${registry.size} ferramentas | 📚 ${skills.length} skills: ${skills.map((s) => s.name).join(', ') || '(nenhuma)'}`);

  // Módulo voz: sem ele, áudios recebidos são recusados e as respostas saem só em texto.
  // O TTS continua montado porque a voz clonada (/falar) também entrega áudio.
  const voice = modules.has('voz');
  const tts = createTextToSpeech(config);
  const stt = voice ? createSpeechToText(config, runner, ffmpeg, tmp) : new DisabledSpeechToText();
  if (voice) {
    logger.info(`🔊 TTS: ${tts.name} (voz ${tts.voice})`);
    logger.info(`🎙️ STT: whisper ${config.whisperEngine} (modelo ${config.whisperModel})`);
  }

  if (options.healthChecks) {
    void checkProviders(llm);
    if (voiceClone) void checkVoiceClone(voiceClone);
    if (images) void checkImages(images, config.images.baseUrl);
    if (voice) {
      void checkTts(tts);
      void checkStt(stt, config.whisperEngine);
    }
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
    attachments,
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
        audioReplies: voice,
      }),
  };
}

/** Módulo imagens: ComfyUI na GPU; antes de gerar, libera a VRAM do Ollama (API nativa, sem /v1). */
function createImageGenerator(config: Config): ImageGenerator {
  return new ImageGenerator({
    comfy: new ComfyUIClient(config.images.baseUrl),
    outputDir: path.join(config.workspaceDir, 'imagens'),
    models: config.images.models,
    defaultStyle: config.images.defaultStyle,
    quality: config.images.quality,
    timeoutMs: config.images.timeoutMs,
    idleUnloadMs: config.images.idleUnloadMs,
    ollamaUrl: config.providers.ollama.baseUrl?.replace(/\/v1$/, ''),
  });
}

async function checkImages(images: ImageGenerator, baseUrl: string): Promise<void> {
  try {
    const checkpoints = await images.healthCheck();
    if (checkpoints.length) logger.info(`✅ Imagens (ComfyUI): ${checkpoints.length} modelo(s): ${checkpoints.join(', ')}`);
    else logger.warn('⚠️ ComfyUI no ar, mas sem modelos em models/checkpoints');
  } catch (error) {
    logger.warn(`⚠️ Gerador de imagens indisponível em ${baseUrl}: ${errorMessage(error)}`);
  }
}

function createVoiceClone(config: Config): VoiceCloneService {
  fs.mkdirSync(config.voiceClone.dir, { recursive: true });
  const service = new VoiceCloneService(
    new VoiceLibrary({ dir: config.voiceClone.dir, defaultVoice: config.voiceClone.defaultVoice }, new AudioSampleConverter()),
    new ChatterboxVoiceCloner(config.voiceClone),
  );
  logger.info(`🗣️ Clonagem de voz: ${service.list().length} voz(es) em ${path.relative(process.cwd(), config.voiceClone.dir) || config.voiceClone.dir}`);
  return service;
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
