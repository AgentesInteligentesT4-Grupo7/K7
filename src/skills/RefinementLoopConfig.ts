import { SUPPORTED_PROVIDERS, type ProviderName } from '../config/Config.js';
import { UserFacingError } from '../errors/AppErrors.js';

export interface RoleConfig {
  /** Tag do SKILL.md que contém o perfil (system prompt) do papel. */
  tag: string;
  provider: ProviderName;
  /** Modelo do provider; vazio = modelo padrão do .env. */
  model?: string;
  profile: string;
}

export interface RefinementLoopConfig {
  iterations: number;
  stopPhrase: string | null;
  creator: RoleConfig;
  critic: RoleConfig;
}

export class SkillConfigError extends UserFacingError {
  constructor(skillName: string, detail: string) {
    super(`A skill "${skillName}" está mal configurada: ${detail}`, `Skill ${skillName}: ${detail}`);
  }
}

const DEFAULT_TAGS = { creator: 'idealizador', critic: 'analisador' } as const;

/**
 * Lê o bloco `loop:` do frontmatter de uma skill de refinamento:
 *
 * ```yaml
 * loop:
 *   iterations: 20
 *   stop_phrase: Estou satisfeito com a ideia
 *   creator: { tag: idealizador, provider: ollama, model: qwen2.5:7b-instruct }
 *   critic:  { tag: analisador,  provider: gemini, model: gemini-3.8-flash }
 * ```
 *
 * Os perfis de cada papel vêm do corpo do SKILL.md, dentro de `<tag>...</tag>`.
 */
export class RefinementLoopConfigParser {
  static hasLoop(frontmatter: Record<string, unknown> | undefined): boolean {
    return typeof frontmatter?.loop === 'object' && frontmatter.loop !== null;
  }

  static parse(skillName: string, frontmatter: Record<string, unknown>, body: string, maxRounds: number): RefinementLoopConfig {
    const loop = frontmatter.loop as Record<string, unknown>;
    const iterations = Number(loop.iterations ?? 20);
    if (!Number.isInteger(iterations) || iterations < 1) {
      throw new SkillConfigError(skillName, '"loop.iterations" deve ser um inteiro ≥ 1');
    }
    if (iterations > maxRounds) {
      throw new SkillConfigError(skillName, `"loop.iterations" (${iterations}) excede REFINEMENT_MAX_ROUNDS (${maxRounds})`);
    }
    const stopPhrase = typeof loop.stop_phrase === 'string' && loop.stop_phrase.trim() ? loop.stop_phrase.trim() : null;

    return {
      iterations,
      stopPhrase,
      creator: RefinementLoopConfigParser.role(skillName, 'creator', loop.creator, body),
      critic: RefinementLoopConfigParser.role(skillName, 'critic', loop.critic, body),
    };
  }

  private static role(skillName: string, key: 'creator' | 'critic', raw: unknown, body: string): RoleConfig {
    if (typeof raw !== 'object' || raw === null) {
      throw new SkillConfigError(skillName, `"loop.${key}" ausente (defina provider e model)`);
    }
    const data = raw as Record<string, unknown>;
    const tag = typeof data.tag === 'string' && data.tag.trim() ? data.tag.trim() : DEFAULT_TAGS[key];
    const provider = String(data.provider ?? '').trim().toLowerCase();
    if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
      throw new SkillConfigError(skillName, `"loop.${key}.provider" inválido ("${provider}"). Use: ${SUPPORTED_PROVIDERS.join(', ')}`);
    }
    const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined;

    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'i').exec(body);
    const profile = match?.[1]?.trim();
    if (!profile) throw new SkillConfigError(skillName, `perfil <${tag}>...</${tag}> não encontrado no corpo do SKILL.md`);

    return { tag, provider: provider as ProviderName, model, profile };
  }
}
