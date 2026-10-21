import { UserFacingError, errorMessage } from '../errors/AppErrors.js';
import { TaskClassifier } from '../llm/orchestration/TaskClassifier.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { PrivacyLevel, Task } from '../llm/orchestration/types.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { SkillExecutor } from '../skills/SkillExecutor.js';
import type { SkillLoader, SkillMetadata } from '../skills/SkillLoader.js';
import type { SkillRouter } from '../skills/SkillRouter.js';
import { Logger, preview } from '../utils/Logger.js';
import type { AgentInput, AgentResponse, IOutputHandler } from './types.js';

export interface AgentControllerDeps {
  memory: MemoryManager;
  skillLoader: SkillLoader;
  skillRouter: SkillRouter;
  skillExecutor: SkillExecutor;
  output: IOutputHandler;
  providerName: string;
  /** Privacidade padrão das conversas (PRIVACY_DEFAULT); documentos sobem para "pessoal". */
  privacyDefault?: PrivacyLevel;
}

const PRIVACY_ORDER: PrivacyLevel[] = ['publico', 'pessoal', 'local'];
const stricter = (a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel =>
  PRIVACY_ORDER.indexOf(a) >= PRIVACY_ORDER.indexOf(b) ? a : b;

/**
 * Facade da aplicação: recebe a entrada normalizada e orquestra
 * Memória → Skills (Loader/Router/Executor) → AgentLoop → Output.
 */
export class AgentController {
  private readonly logger = new Logger('Controller');

  constructor(private readonly deps: AgentControllerDeps) {}

  /** Processa a entrada e entrega a resposta (ou o erro formatado) no chat. */
  async handle(input: AgentInput): Promise<void> {
    const started = Date.now();
    this.logger.info(`📩 [${input.source}] user=${input.userId}: ${preview(input.text, 120)}`);
    try {
      const response = await this.process(input);
      await this.deps.output.send(input.chatId, response);
      this.logger.info(`📤 Resposta entregue em ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      if (error instanceof UserFacingError) this.logger.warn(error.message);
      else this.logger.error(`Falha no processamento: ${errorMessage(error)}`, error);
      await this.deps.output.sendError(input.chatId, error);
    }
  }

  async process(input: AgentInput): Promise<AgentResponse> {
    const { memory } = this.deps;
    const userId = String(input.userId);
    const conversation = memory.getOrCreateActiveConversation(userId, this.deps.providerName);

    // A entrada é persistida ANTES do LLM: se o provider cair, o texto (ex.: transcrição) não se perde.
    const saved = memory.saveMessage(conversation.id, 'user', input.text, {
      channel: input.channel ?? 'telegram',
      source: input.source,
      requires_audio_reply: input.requiresAudioReply,
      ...(input.voiceId ? { voice_id: input.voiceId } : {}),
      ...(input.attachmentName ? { attachment: input.attachmentName } : {}),
    });

    const history = memory.getContextWindow(conversation.id);
    if (!saved) history.push({ role: 'user', content: input.text });

    // Hot-reload: as skills são relidas do disco a cada requisição.
    const skills = this.deps.skillLoader.loadAll();
    // Privacidade: documentos e anexos são dados pessoais (spec llm-orchestration RF-09).
    const privacy = input.source === 'document' ? stricter(this.deps.privacyDefault ?? 'publico', 'pessoal') : (this.deps.privacyDefault ?? 'publico');
    const routed = await TaskContext.run({ task: 'roteamento', privacy, userId }, () =>
      this.deps.skillRouter.routeWithTask(input.text, skills),
    );
    const skill = routed.skill;
    const task: Task = routed.task ?? TaskClassifier.fromSkill(skill?.name) ?? TaskClassifier.heuristic(input.text);

    const result = await TaskContext.run({ task, privacy, userId }, () =>
      this.deps.skillExecutor.execute({ skill, availableSkills: skills, history, input }),
    );

    for (const step of result.steps) {
      memory.saveMessage(conversation.id, 'tool', `${step.tool}(${step.arguments}) → ${step.observation}`, {
        tool: step.tool,
        iteration: step.iteration,
      });
    }
    memory.saveMessage(
      conversation.id,
      'assistant',
      result.text,
      { provider: result.providerName, skill: result.skillName, task, privacy, iterations: result.iterations, ...result.details },
      result.providerName,
    );

    return { text: result.text, isAudio: input.requiresAudioReply };
  }

  newConversation(userId: number | string): void {
    const conversation = this.deps.memory.startNewConversation(String(userId), this.deps.providerName);
    this.logger.info(`🆕 Conversa reiniciada para user=${userId} (${conversation.id.slice(0, 8)})`);
  }

  listSkills(): SkillMetadata[] {
    return this.deps.skillLoader.loadAll();
  }
}
