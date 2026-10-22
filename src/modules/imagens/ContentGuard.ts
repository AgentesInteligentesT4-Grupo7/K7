import { UserFacingError } from '../../errors/AppErrors.js';

/** Pedido de imagem fora do permitido (spec image-generation NG-01 / RF-13). */
export class ForbiddenImageError extends UserFacingError {
  constructor(reason: string) {
    super(`Não gero essa imagem: ${reason}. Posso ajudar com outra cena.`, `Prompt de imagem recusado: ${reason}`);
  }
}

const SEXUAL = /\b(nsfw|nude|nudity|naked|topless|bottomless|sex|sexual|sexy|erotic|porn\w*|hentai|lewd|explicit|lingerie|underwear|bikini|nipples?|genitals?|breasts?|cleavage|seductive|provocative|fetish|bdsm|nu[ae]?s?|pelad[oa]s?|sensual|er[oó]tic[oa]|pornogr[aá]fic[oa])\b/i;
const MINOR = /\b(child|children|kid|kids|minor|minors|underage|loli|lolita|shota|toddler|baby|infant|preteen|teen|teenager|schoolgirl|schoolboy|young girl|young boy|little girl|little boy|crian[cç]as?|menin[oa]s?|beb[eê]s?|adolescentes?|infantil)\b/i;
const GORE = /\b(gore|dismember\w*|decapitat\w*|mutilat\w*|disembowel\w*|torture|tortura|esquartej\w*)\b/i;

/**
 * Primeira barreira, antes de gastar GPU: o LLM já deve recusar, mas o tocador confere o
 * prompt final. Criança/adolescente em qualquer contexto sexualizado é bloqueio sem exceção.
 */
export function checkImagePrompt(prompt: string): void {
  const sexual = SEXUAL.test(prompt);
  if (sexual && MINOR.test(prompt)) throw new ForbiddenImageError('conteúdo sexual envolvendo menores é proibido');
  if (sexual) throw new ForbiddenImageError('conteúdo sexual ou nudez não é permitido');
  if (GORE.test(prompt)) throw new ForbiddenImageError('violência gráfica extrema não é permitida');
}
