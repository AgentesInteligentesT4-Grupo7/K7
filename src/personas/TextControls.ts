/** Níveis por dimensão (1–10; perspectiva 1–3). */
export type TextControls = Record<string, number>;

interface Dimension {
  label: string;
  max: number;
  low: string;
  high: string;
}

/**
 * Dimensões de controle do texto (spec personas-styles §5.4), inspiradas nos "níveis de controle"
 * da engenharia de prompts: cada uma vai de 1 a 10 e completa o estilo escolhido.
 */
export const DIMENSIONS: Record<string, Dimension> = {
  complexidade: { label: 'Complexidade', max: 10, low: 'palavras do dia a dia e frases curtas', high: 'vocabulário técnico e frases elaboradas' },
  entonacao: { label: 'Entonação', max: 10, low: 'sóbria e séria', high: 'animada e descontraída' },
  sentimento: { label: 'Sentimento', max: 10, low: 'crítico e negativo', high: 'positivo e entusiasmado (5 = neutro)' },
  perspectiva: { label: 'Perspectiva', max: 3, low: '', high: '' },
  foco: { label: 'Foco', max: 10, low: 'visão ampla, com contexto e temas vizinhos', high: 'só o ponto central, sem desvios' },
  surpresa: { label: 'Surpresa', max: 10, low: 'previsível, sem reviravoltas', high: 'inesperado, com ganchos e reviravoltas' },
  detalhe: { label: 'Detalhe', max: 10, low: 'só o essencial', high: 'minucioso, com exemplos e casos' },
  originalidade: { label: 'Originalidade', max: 10, low: 'convencional, expressões consagradas', high: 'criativo, imagens e ideias inéditas' },
  abstracao: { label: 'Abstração', max: 10, low: 'concreto, com exemplos práticos', high: 'conceitual, com princípios e ideias gerais' },
};

const ALIASES: Record<string, string> = {
  tom: 'entonacao',
  complexo: 'complexidade',
  sentimentos: 'sentimento',
  pessoa: 'perspectiva',
  detalhes: 'detalhe',
  detalhamento: 'detalhe',
  criatividade: 'originalidade',
  abstrato: 'abstracao',
};

const PERSPECTIVES = ['1ª pessoa (eu/nós: quem escreve fala de si)', '2ª pessoa (fale direto com o leitor: "você")', '3ª pessoa (narrador externo: "ele", "ela", "eles")'];

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Nome canônico da dimensão ("tom" → "entonacao"), ou undefined. */
export function dimensionName(name: string): string | undefined {
  let key = plain(name);
  for (let i = 0; i < 2 && ALIASES[key]; i++) key = ALIASES[key]!;
  return DIMENSIONS[key] ? key : undefined;
}

/** Valida um mapa vindo de frontmatter/YAML ou de configurações salvas; ignora o que não vale. */
export function sanitizeControls(raw: unknown): TextControls {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: TextControls = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = dimensionName(name);
    const level = Number(value);
    if (key && Number.isInteger(level) && level >= 1 && level <= DIMENSIONS[key]!.max) out[key] = level;
  }
  return out;
}

/** "nome=N" colado (sem espaço), para não confundir com texto comum como "meu foco: 2 coisas". */
const TOKEN = /(?<![\p{L}\p{N}])([\p{L}]+)=(\d{1,2})(?![\p{N}])/gu;

/**
 * Extrai "detalhe=3 tom=8" de um texto. Só tokens com dimensão conhecida e nível válido são
 * consumidos; o resto do texto volta intacto (sem os tokens).
 */
export function parseControls(text: string): { controls: TextControls; rest: string } {
  const controls: TextControls = {};
  const rest = text.replace(TOKEN, (match, name: string, value: string) => {
    const key = dimensionName(name);
    const level = Number(value);
    if (!key || level < 1 || level > DIMENSIONS[key]!.max) return match;
    controls[key] = level;
    return '';
  });
  return { controls, rest: Object.keys(controls).length ? rest.replace(/[ \t]{2,}/g, ' ').trim() : text };
}

/** "detalhe=3, tom=8" para mostrar ao usuário. */
export function formatControls(controls: TextControls): string {
  return Object.entries(controls)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

/** Seção do system prompt com os níveis pedidos. */
export function renderControls(controls: TextControls): string {
  const lines = Object.entries(controls).flatMap(([key, level]) => {
    const dim = DIMENSIONS[key];
    if (!dim) return [];
    if (key === 'perspectiva') return [`- ${dim.label}: escreva em ${PERSPECTIVES[level - 1]}.`];
    return [`- ${dim.label}: ${level}/10 (1 = ${dim.low}; 10 = ${dim.high}).`];
  });
  return lines.length ? `# Controles do texto\nAjuste o texto a estes níveis (eles prevalecem sobre o estilo quando houver conflito):\n${lines.join('\n')}` : '';
}

/** Ajuda curta para /estilo. */
export function controlsHelp(): string {
  return Object.entries(DIMENSIONS)
    .map(([key, dim]) => (key === 'perspectiva' ? `${key}=1..3 (1ª, 2ª ou 3ª pessoa)` : `${key}=1..10 (${dim.low} → ${dim.high})`))
    .join('\n');
}
