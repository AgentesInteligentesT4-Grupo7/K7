import { errorMessage } from '../errors/AppErrors.js';
import type { ILlmProvider } from '../llm/types.js';
import type { RefinementLoopConfig } from '../skills/RefinementLoopConfig.js';
import { Logger, preview } from '../utils/Logger.js';

export interface RefinementRunInput {
  /** Pedido/problema do usuário. */
  problem: string;
  config: RefinementLoopConfig;
  creator: ILlmProvider;
  critic: ILlmProvider;
}

export interface RefinementRunResult {
  idea: string;
  /** Rodadas (crítica + revisão) concluídas. */
  rounds: number;
  /** O crítico escreveu a frase de parada. */
  satisfied: boolean;
  /** Preenchido quando um provider falhou no meio e devolvemos a melhor ideia até então. */
  interruptedBy: string | null;
}

const OUTPUT_RULES = `Responda SOMENTE com o texto pedido, em português do Brasil, sem preâmbulos nem comentários sobre o processo.`;

/**
 * Loop criador ↔ crítico executado pelo código (não pelo LLM), para que as N
 * rodadas aconteçam de fato e cada papel use o seu próprio modelo:
 *
 *   {ideia} = criador(problema)
 *   repete N vezes:
 *     {crítica} = crítico({ideia})          → para se contiver a frase de parada
 *     {ideia}   = criador({ideia}, {crítica})
 *
 * Cada chamada recebe só o estado atual (ideia + última crítica), então o
 * contexto não cresce com as rodadas.
 */
export class RefinementLoop {
  private readonly logger = new Logger('Refinement');

  async run(input: RefinementRunInput): Promise<RefinementRunResult> {
    const { config, creator, critic, problem } = input;
    const creatorName = `${config.creator.tag} (${creator.name}/${creator.model})`;
    const criticName = `${config.critic.tag} (${critic.name}/${critic.model})`;
    this.logger.info(`🔁 Iniciando refinamento: ${creatorName} ↔ ${criticName}, até ${config.iterations} rodadas`);

    let idea = await this.ask(creator, config.creator.profile, [
      `Problema do usuário:\n"""\n${problem}\n"""`,
      'Crie uma ideia para resolver esse problema. Ela será armazenada em {ideia}.',
      OUTPUT_RULES,
    ]);
    this.logger.info(`💡 Ideia inicial: ${preview(idea, 160)}`);

    let rounds = 0;
    for (let round = 1; round <= config.iterations; round++) {
      try {
        const critique = await this.ask(critic, config.critic.profile, [
          `Problema original do usuário:\n"""\n${problem}\n"""`,
          `Produção atual do ${config.creator.tag}, armazenada em {ideia}:\n"""\n${idea}\n"""`,
          `Analise criticamente a {ideia}, faça críticas e sugestões de melhoria. Elas serão armazenadas em {crítica}.` +
            (config.stopPhrase
              ? ` Somente se NÃO houver mais nenhuma crítica ou sugestão, responda apenas com a frase "${config.stopPhrase}" e nada mais. Se houver qualquer sugestão, NÃO escreva essa frase.`
              : ''),
          OUTPUT_RULES,
        ]);
        this.logger.info(`🔍 Rodada ${round}/${config.iterations} — crítica: ${preview(critique, 160)}`);

        if (config.stopPhrase && RefinementLoop.isSatisfied(critique, config.stopPhrase)) {
          this.logger.info(`✅ ${config.critic.tag} satisfeito na rodada ${round}`);
          return { idea, rounds, satisfied: true, interruptedBy: null };
        }

        idea = await this.ask(creator, config.creator.profile, [
          `Problema original do usuário:\n"""\n${problem}\n"""`,
          `Sua ideia atual, armazenada em {ideia}:\n"""\n${idea}\n"""`,
          `Crítica do ${config.critic.tag}, armazenada em {crítica}:\n"""\n${critique}\n"""`,
          'Atualize a {ideia} aplicando as sugestões da {crítica}. Devolva a nova versão COMPLETA da ideia (não apenas as mudanças).',
          OUTPUT_RULES,
        ]);
        rounds = round;
        this.logger.info(`✏️  Rodada ${round}/${config.iterations} — ideia revisada: ${preview(idea, 160)}`);
      } catch (error) {
        // Melhor entregar a última ideia válida do que perder minutos de refinamento.
        this.logger.warn(`Refinamento interrompido na rodada ${round}: ${errorMessage(error)}`);
        return { idea, rounds, satisfied: false, interruptedBy: errorMessage(error) };
      }
    }

    this.logger.info(`🏁 Limite de ${config.iterations} rodadas atingido`);
    return { idea, rounds, satisfied: false, interruptedBy: null };
  }

  private async ask(provider: ILlmProvider, profile: string, parts: string[]): Promise<string> {
    const response = await provider.chat({
      messages: [
        { role: 'system', content: profile },
        { role: 'user', content: parts.join('\n\n') },
      ],
    });
    const text = RefinementLoop.stripPlaceholderLabel(response.content ?? '');
    if (!text) throw new Error(`${provider.name}/${provider.model} devolveu resposta vazia`);
    return text;
  }

  /** Modelos menores costumam ecoar o rótulo ("{ideia} - ...", "**{crítica}:**"); removemos do início. */
  static stripPlaceholderLabel(text: string): string {
    return text
      .trim()
      .replace(/^[*_#>\s]*\{(?:ideia|cr[ií]tica)\}[*_\s]*[:\-–—=]?[*_\s]*/i, '')
      .trim();
  }

  /**
   * O crítico está satisfeito quando escreve a frase de parada SEM continuar criticando.
   * Modelos menores às vezes listam sugestões e colam a frase no fim — isso não conta.
   */
  static isSatisfied(critique: string, phrase: string, maxExtraChars = 120): boolean {
    if (!RefinementLoop.contains(critique, phrase)) return false;
    const rest = RefinementLoop.normalize(critique).replace(RefinementLoop.normalize(phrase), '').trim();
    return rest.length <= maxExtraChars;
  }

  private static normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Comparação tolerante a maiúsculas, acentos e pontuação; ignora a forma negada ("não estou satisfeito"). */
  static contains(text: string, phrase: string): boolean {
    const normalize = RefinementLoop.normalize;
    const haystack = ` ${normalize(text)} `;
    const needle = normalize(phrase);
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      const before = haystack.slice(Math.max(0, index - 12), index);
      if (!/\b(nao|ainda nao|nunca)\s*$/.test(before)) return true;
      index = haystack.indexOf(needle, index + 1);
    }
    return false;
  }
}
