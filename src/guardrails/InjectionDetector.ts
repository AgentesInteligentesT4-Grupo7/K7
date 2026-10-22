/** Resultado da varredura heurística de prompt injection. */
export interface InjectionScan {
  suspicious: boolean;
  /** Rótulos dos padrões encontrados (para log e para o aviso ao LLM). */
  matches: string[];
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Padrões clássicos de injeção (pt e en), aplicados ao texto sem acentos e em minúsculas.
 * Heurística barata: serve para marcar conteúdo externo e decidir quando gastar um LLM verificador.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ['ignorar instruções', /\b(ignore|ignora|ignorar|desconsidere|desconsiderar|esqueca|esquecer|forget|disregard)\b.{0,40}\b(instruc|regra|solicitac|ordens|comando|anterior|previous|prior|above|instructions|rules)/],
  ['troca de papel', /\b(voce agora e|a partir de agora voce e|finja que voce e|aja como se fosse|you are now|from now on you are|pretend (to be|you are))\b/],
  ['vazar o prompt', /\b(revele|mostre|repita|imprima|reveal|print|show|repeat)\b.{0,40}\b(system prompt|prompt do sistema|suas instrucoes|your instructions|instrucoes iniciais|initial instructions)/],
  ['jailbreak', /\b(jailbreak|dan mode|modo dan|developer mode|modo desenvolvedor|sem restricoes|without (any )?restrictions|no (rules|limits))\b/],
  ['marcador de sistema', /(<\/?system>|\[system\]|###\s*system|<\|im_start\|>|<\|system\|>)/],
  ['nova instrução', /\b(nova instrucao|new instructions?|instrucao do sistema|system override|atencao,? assistente|attention,? (assistant|ai))\b/],
  ['exfiltração', /\b(envie|mande|send|post|transfira)\b.{0,60}\b(senha|token|chave|api key|password|credenciais|credentials)\b/],
];

/** Detector heurístico (spec guardrails RF-01). */
export class InjectionDetector {
  scan(text: string): InjectionScan {
    const plain = normalize(text);
    const matches = PATTERNS.filter(([, re]) => re.test(plain)).map(([label]) => label);
    return { suspicious: matches.length > 0, matches };
  }
}
