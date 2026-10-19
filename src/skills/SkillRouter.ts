import { errorMessage } from '../errors/AppErrors.js';
import type { ILlmProvider } from '../llm/types.js';
import { Logger, preview } from '../utils/Logger.js';
import type { SkillMetadata } from './SkillLoader.js';

const ROUTER_SYSTEM_PROMPT = `Você é um roteador de intenções. Sua única tarefa é decidir qual skill (habilidade) deve ser ativada para atender a mensagem do usuário.

Regras:
- Responda SOMENTE com um objeto JSON válido, sem texto adicional e sem blocos de código.
- Formato obrigatório: {"skillName": "<nome-exato-da-skill>"} ou {"skillName": null}
- Use null quando nenhuma skill se aplicar claramente (ex.: conversa casual, cumprimentos, perguntas gerais).
- Escolha no máximo UMA skill, usando exatamente o "name" listado.`;

/**
 * "Passo zero": chamada leve ao LLM só com os descritivos das skills
 * e a intenção do usuário. Qualquer falha (rede, parse, nome inexistente)
 * equivale a `null` — fallback para o agente casual.
 */
export class SkillRouter {
  private readonly logger = new Logger('SkillRouter');

  constructor(
    private readonly provider: ILlmProvider,
    private readonly maxInputChars = 2000,
  ) {}

  async route(userText: string, skills: SkillMetadata[]): Promise<SkillMetadata | null> {
    if (skills.length === 0) return null;

    const catalog = skills.map((skill) => `- name: ${skill.name}\n  description: ${skill.description}`).join('\n');
    const prompt = `Skills disponíveis:\n${catalog}\n\nMensagem do usuário:\n"""\n${userText.slice(0, this.maxInputChars)}\n"""`;

    try {
      const response = await this.provider.chat({
        messages: [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
      });
      const skillName = SkillRouter.parseSkillName(response.content);
      const skill = skillName ? skills.find((item) => item.name.toLowerCase() === skillName.toLowerCase()) : undefined;

      if (skillName && !skill) this.logger.warn(`Router sugeriu skill inexistente "${skillName}"; usando agente casual`);
      this.logger.info(`🧭 Router → ${skill ? skill.name : 'null (agente casual)'}`);
      return skill ?? null;
    } catch (error) {
      this.logger.warn(`Router falhou (${errorMessage(error)}); usando agente casual`);
      return null;
    }
  }

  /** Extrai `skillName` da resposta. Parse error ou formato inesperado → null. */
  static parseSkillName(content: string | null): string | null {
    if (!content) return null;
    const cleaned = content.replace(/```(?:json)?/gi, '').trim();
    const match = /\{[\s\S]*\}/.exec(cleaned);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as { skillName?: unknown };
      return typeof parsed.skillName === 'string' && parsed.skillName.trim() ? parsed.skillName.trim() : null;
    } catch {
      new Logger('SkillRouter').debug(`Resposta do router não é JSON: ${preview(content, 120)}`);
      return null;
    }
  }
}
