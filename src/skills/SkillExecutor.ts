import type { AgentLoop, AgentRunResult } from '../agent/AgentLoop.js';
import { RefinementLoop } from '../agent/RefinementLoop.js';
import type { SystemPromptBuilder } from '../agent/SystemPromptBuilder.js';
import type { AgentInput } from '../agent/types.js';
import type { ProviderName } from '../config/Config.js';
import { errorMessage } from '../errors/AppErrors.js';
import type { ChatMessage, ILlmProvider } from '../llm/types.js';
import { Logger } from '../utils/Logger.js';
import { RefinementLoopConfigParser } from './RefinementLoopConfig.js';
import type { SkillLoader, SkillMetadata } from './SkillLoader.js';

export interface SkillExecutionRequest {
  skill: SkillMetadata | null;
  availableSkills: SkillMetadata[];
  history: ChatMessage[];
  input: AgentInput;
}

export interface SkillExecutionResult extends AgentRunResult {
  skillName: string | null;
  /** Metadados extras para persistência (ex.: rodadas do refinamento). */
  details?: Record<string, unknown>;
}

/** Cria providers com modelo específico para os papéis das skills de refinamento. */
export interface IRoleProviderResolver {
  createForRole(name: ProviderName, model?: string): ILlmProvider;
}

export interface SkillExecutorOptions {
  roleProviders: IRoleProviderResolver;
  /** Teto de rodadas aceito no frontmatter (REFINEMENT_MAX_ROUNDS). */
  maxRefinementRounds: number;
  refinementLoop?: RefinementLoop;
}

/**
 * Injeta as instruções completas da skill escolhida no System Prompt apenas
 * durante esta requisição (Runtime Injection) e dispara o AgentLoop.
 * Skills com bloco `loop:` no frontmatter rodam o RefinementLoop (criador ↔ crítico).
 * A string da skill é descartada ao final — o próximo comando começa limpo.
 */
export class SkillExecutor {
  private readonly logger = new Logger('SkillExecutor');
  private readonly refinementLoop: RefinementLoop;

  constructor(
    private readonly loader: SkillLoader,
    private readonly promptBuilder: SystemPromptBuilder,
    private readonly agentLoop: AgentLoop,
    private readonly options: SkillExecutorOptions,
  ) {
    this.refinementLoop = options.refinementLoop ?? new RefinementLoop();
  }

  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    let activeSkill: { name: string; content: string } | null = null;
    if (request.skill) {
      try {
        const content = this.loader.loadContent(request.skill);
        activeSkill = { name: request.skill.name, content };
        this.logger.info(`📚 Skill "${request.skill.name}" injetada (${Buffer.byteLength(content, 'utf8')} bytes)`);
      } catch (error) {
        this.logger.warn(`Não foi possível ler a skill "${request.skill.name}": ${errorMessage(error)}`);
      }
    }

    if (request.skill && activeSkill && RefinementLoopConfigParser.hasLoop(request.skill.frontmatter)) {
      return this.executeRefinement(request.skill, activeSkill.content, request.input.text);
    }

    const systemPrompt = this.promptBuilder.build({
      availableSkills: request.availableSkills,
      activeSkill,
      input: request.input,
    });

    const result = await this.agentLoop.run({ systemPrompt, history: request.history });
    return { ...result, skillName: activeSkill?.name ?? null };
  }

  private async executeRefinement(skill: SkillMetadata, body: string, problem: string): Promise<SkillExecutionResult> {
    const config = RefinementLoopConfigParser.parse(skill.name, skill.frontmatter!, body, this.options.maxRefinementRounds);
    const creator = this.options.roleProviders.createForRole(config.creator.provider, config.creator.model);
    const critic = this.options.roleProviders.createForRole(config.critic.provider, config.critic.model);

    const result = await this.refinementLoop.run({ problem, config, creator, critic });
    return {
      text: result.idea,
      iterations: result.rounds,
      steps: [],
      providerName: `${creator.name}:${creator.model} ↔ ${critic.name}:${critic.model}`,
      skillName: skill.name,
      details: {
        refinement_rounds: result.rounds,
        critic_satisfied: result.satisfied,
        ...(result.interruptedBy ? { interrupted_by: result.interruptedBy } : {}),
      },
    };
  }
}
