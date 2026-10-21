import { TASKS, type Task } from './types.js';

/** Skills cujo tipo de tarefa é conhecido de antemão. */
const SKILL_TASKS: Record<string, Task> = {
  'prd-manager': 'raciocinio',
  resumidor: 'resumo',
  'gestor-arquivos': 'conversa',
  'voz-clonada': 'conversa',
  'idealizador-analisador': 'raciocinio',
  'pesquisador-web': 'pesquisa',
  noticias: 'pesquisa',
};

const RULES: Array<[Task, RegExp]> = [
  ['codigo', /```|\b(c[oó]digo|fun[cç][aã]o|bug|stack ?trace|exce[cç][aã]o|typescript|javascript|python|java|sql|regex|compila|refator|api|endpoint|erro de|npm|git)\b/i],
  ['resumo', /\b(resum[aoie]|resumo|sintetiz|tl;?dr)\b/i],
  ['pesquisa', /\b(quem (é|foi|ganhou)|quando (foi|é|será)|pre[cç]o d|cota[cç][aã]o|not[ií]cia|hoje|ontem|atual(mente)?|[uú]ltim[oa]s?|recente|campe[aã]o|t[ií]tulos?|resultado d)\b/i],
  ['raciocinio', /\b(calcule|quanto (é|d[aá])|prove|demonstre|l[oó]gica|planej|plano|compare|analis[ea]|estrat[eé]gia|passo a passo|por que)\b/i],
];

/**
 * Classificação da tarefa: o SkillRouter tenta pela LLM (mesma chamada do passo zero);
 * quando não há skills, ou a resposta não traz a tarefa, esta heurística decide sem custo.
 */
export class TaskClassifier {
  static parse(value: unknown): Task | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return (TASKS as readonly string[]).includes(normalized) ? (normalized as Task) : null;
  }

  static fromSkill(skillName: string | null | undefined): Task | null {
    return skillName ? (SKILL_TASKS[skillName] ?? null) : null;
  }

  static heuristic(text: string, options: { hasImage?: boolean } = {}): Task {
    if (options.hasImage) return 'visao';
    for (const [task, pattern] of RULES) if (pattern.test(text)) return task;
    return 'conversa';
  }
}
