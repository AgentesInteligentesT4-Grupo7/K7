/**
 * Bloco `guardrails:` do perfil.yaml (spec guardrails §4). Exemplo:
 *
 *   guardrails:
 *     injecao: bloquear            # off | avisar | bloquear (mensagem do usuário)
 *     verificar_com_llm: true      # confirma casos suspeitos e o tópico com o LLM de roteamento
 *     dados_pessoais: mascarar     # off | mascarar | bloquear (resposta)
 *     proibidas: { palavras: [...], acao: refazer }   # corrigir | refazer | bloquear
 *     topicos: { permitidos: [...], proibidos: [...], acao: bloquear }   # bloquear | avisar
 *     abster: [saude, juridico, financeiro]
 */
export type InjectionMode = 'off' | 'avisar' | 'bloquear';
export type PiiMode = 'off' | 'mascarar' | 'bloquear';
export type BannedAction = 'corrigir' | 'refazer' | 'bloquear';
export type TopicAction = 'bloquear' | 'avisar';

export interface GuardrailsConfig {
  injection: InjectionMode;
  llmCheck: boolean;
  pii: PiiMode;
  banned: { words: string[]; action: BannedAction };
  topics: { allowed: string[]; forbidden: string[]; action: TopicAction };
  abstain: string[];
}

export const DEFAULT_GUARDRAILS: GuardrailsConfig = {
  injection: 'avisar',
  llmCheck: false,
  pii: 'off',
  banned: { words: [], action: 'corrigir' },
  topics: { allowed: [], forbidden: [], action: 'bloquear' },
  abstain: [],
};

/** Áreas de abstenção conhecidas, com o texto da regra; outras viram regra genérica. */
export const ABSTAIN_AREAS: Record<string, string> = {
  saude: 'saúde (diagnósticos, remédios, doses, tratamentos)',
  juridico: 'questões jurídicas (processos, contratos, direitos)',
  financeiro: 'investimentos e decisões financeiras',
  seguranca: 'segurança física (eletricidade, gás, química, armas)',
};

type Fail = (field: string, problem: string) => never;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T, fail: Fail): T {
  if (value === undefined || value === null) return fallback;
  // YAML lê "off" como false.
  const text = value === false ? 'off' : value === true ? allowed[1]! : String(value).trim().toLowerCase();
  if (!allowed.includes(text as T)) fail(field, `deve ser ${allowed.join(', ')}`);
  return text as T;
}

function words(value: unknown, field: string, fail: Fail): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(field, 'deve ser uma lista');
  return (value as unknown[]).map((w) => String(w).trim()).filter(Boolean);
}

export function parseGuardrails(raw: unknown, fail: Fail): GuardrailsConfig {
  if (raw === undefined || raw === null) return DEFAULT_GUARDRAILS;
  if (!isRecord(raw)) return fail('guardrails', 'deve ser um objeto');
  const proibidas = raw.proibidas ?? {};
  const topicos = raw.topicos ?? {};
  // "proibidas: [a, b]" é atalho para a lista de palavras com a ação padrão.
  const bannedRaw = Array.isArray(proibidas) ? { palavras: proibidas } : proibidas;
  if (!isRecord(bannedRaw)) fail('guardrails.proibidas', 'deve ser uma lista ou { palavras, acao }');
  if (!isRecord(topicos)) fail('guardrails.topicos', 'deve ser { permitidos, proibidos, acao }');
  const banned = bannedRaw as Record<string, unknown>;
  const topics = topicos as Record<string, unknown>;
  const abstain = words(raw.abster, 'guardrails.abster', fail).map((a) => a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase());
  return {
    injection: oneOf(raw.injecao, ['off', 'avisar', 'bloquear'] as const, 'guardrails.injecao', 'avisar', fail),
    llmCheck: raw.verificar_com_llm === true,
    pii: oneOf(raw.dados_pessoais, ['off', 'mascarar', 'bloquear'] as const, 'guardrails.dados_pessoais', 'off', fail),
    banned: {
      words: words(banned.palavras, 'guardrails.proibidas.palavras', fail),
      action: oneOf(banned.acao, ['corrigir', 'refazer', 'bloquear'] as const, 'guardrails.proibidas.acao', 'corrigir', fail),
    },
    topics: {
      allowed: words(topics.permitidos, 'guardrails.topicos.permitidos', fail),
      forbidden: words(topics.proibidos, 'guardrails.topicos.proibidos', fail),
      action: oneOf(topics.acao, ['bloquear', 'avisar'] as const, 'guardrails.topicos.acao', 'bloquear', fail),
    },
    abstain,
  };
}
