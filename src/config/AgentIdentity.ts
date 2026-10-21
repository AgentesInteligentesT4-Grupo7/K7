/**
 * Identidade do agente, configurável pelo .env. Permite usar o mesmo código em
 * projetos com focos diferentes (ex.: agente pessoal, bot de promoções).
 */
export interface AgentIdentity {
  /** Nome do agente (AGENT_NAME). */
  name: string;
  /** Emoji usado em banners e mensagens (AGENT_EMOJI). */
  emoji: string;
  /** Nome do dono/usuário principal (OWNER_NAME). */
  owner: string;
  /** Foco do projeto em uma frase (AGENT_PURPOSE), ex.: "agente pessoal de IA". */
  purpose: string;
  /** Instruções extras de foco e estilo, adicionadas ao system prompt (AGENT_INSTRUCTIONS). */
  instructions: string;
  /** Idioma padrão das respostas (AGENT_LANGUAGE). */
  language: string;
}

export const DEFAULT_IDENTITY: AgentIdentity = {
  name: 'AgroMinds',
  emoji: '🦀',
  owner: 'Agro',
  purpose: 'agente pessoal de IA',
  instructions: '',
  language: 'português do Brasil',
};

export function identityFromEnv(env: NodeJS.ProcessEnv): AgentIdentity {
  const pick = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  return {
    name: pick(env.AGENT_NAME, DEFAULT_IDENTITY.name),
    emoji: pick(env.AGENT_EMOJI, DEFAULT_IDENTITY.emoji),
    owner: pick(env.OWNER_NAME, DEFAULT_IDENTITY.owner),
    purpose: pick(env.AGENT_PURPOSE, DEFAULT_IDENTITY.purpose),
    // "\n" literal no .env vira quebra de linha (o dotenv não expande em valores sem aspas duplas).
    instructions: (env.AGENT_INSTRUCTIONS ?? '').replace(/\\n/g, '\n').trim(),
    language: pick(env.AGENT_LANGUAGE, DEFAULT_IDENTITY.language),
  };
}

/** Substitui {{AGENT_NAME}}, {{AGENT_EMOJI}}, {{OWNER_NAME}}, {{AGENT_PURPOSE}} e {{AGENT_LANGUAGE}} num texto (ex.: SKILL.md). */
export function renderIdentity(text: string, identity: AgentIdentity): string {
  const values: Record<string, string> = {
    AGENT_NAME: identity.name,
    AGENT_EMOJI: identity.emoji,
    OWNER_NAME: identity.owner,
    AGENT_PURPOSE: identity.purpose,
    AGENT_LANGUAGE: identity.language,
  };
  return text.replace(/\{\{\s*(AGENT_NAME|AGENT_EMOJI|OWNER_NAME|AGENT_PURPOSE|AGENT_LANGUAGE)\s*\}\}/g, (_m, key: string) => values[key]!);
}
