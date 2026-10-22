import { load as parseYaml } from 'js-yaml';
import { ConfigError } from '../config/Config.js';
import { REASONING_MODES, parseMode } from '../agent/Reasoning.js';
import { type GuardrailsConfig, parseGuardrails } from '../guardrails/GuardrailsConfig.js';
import type { PrivacyLevel } from '../llm/orchestration/types.js';
import { CHANNELS, type ChannelId, MODULE_IDS } from '../modules/registry.js';

/** Erro no perfil (manifesto, versão, variáveis): mensagem acionável, sem stack. */
export class ProfileError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface ProfileIdentity {
  nome?: string;
  emoji?: string;
  dono?: string;
  proposito?: string;
  instrucoes?: string;
  idioma?: string;
}

/** `perfil.yaml` validado (spec profiles-modules RF-03). */
export interface ProfileManifest {
  nome: string;
  versao: string;
  descricao: string;
  /** Faixa de versões do tocador aceita, ex.: ">=1.0". */
  tocador?: string;
  identidade: ProfileIdentity;
  /** Módulos ligados; as opções de cada um ficam em `opcoesModulos`. */
  modulos: string[];
  opcoesModulos: Record<string, Record<string, unknown>>;
  /** Canais que o perfil usa (padrão: telegram e terminal; web é opcional). */
  canais?: ChannelId[];
  privacidade?: PrivacyLevel;
  /** Estilo de texto padrão da fita (ex.: formal, infantil). */
  estiloPadrao?: string;
  /** Modo de raciocínio padrão da fita: normal, reformular ou verificado. */
  modoPadrao?: string;
  /** Variáveis de ambiente que o `.env` do perfil precisa ter, com a descrição de cada uma. */
  variaveis: Record<string, string>;
  /** Bloco `guardrails:` (spec guardrails); ausente = padrão do tocador. */
  guardrails?: GuardrailsConfig;
}

/** Módulos previstos na spec que ainda não existem neste tocador. */
const FUTURE_MODULES = new Set(['historias', 'promocoes']);
const PRIVACY_LEVELS: PrivacyLevel[] = ['publico', 'pessoal', 'local'];
const IDENTITY_KEYS: Array<keyof ProfileIdentity> = ['nome', 'emoji', 'dono', 'proposito', 'instrucoes', 'idioma'];
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseManifest(text: string, source = 'perfil.yaml'): ProfileManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ProfileError(`${source}: YAML inválido (${(error as Error).message.split('\n')[0]})`);
  }
  if (!isRecord(raw)) throw new ProfileError(`${source}: o manifesto deve ser um objeto YAML`);
  const fail = (field: string, problem: string): never => {
    throw new ProfileError(`${source}: campo "${field}" ${problem}`);
  };

  const nome = str(raw.nome);
  if (!nome) fail('nome', 'é obrigatório');
  if (!PROFILE_NAME_PATTERN.test(nome!)) fail('nome', 'deve ter só letras minúsculas, números e hífen (ex.: "historias")');

  const requer = raw.requer === undefined ? {} : raw.requer;
  if (!isRecord(requer)) fail('requer', 'deve ser um objeto (ex.: requer: { tocador: ">=1.0" })');
  const tocador = str((requer as Record<string, unknown>).tocador);
  if (tocador && !parseRange(tocador)) fail('requer.tocador', `tem faixa inválida "${tocador}" (use ">=1.0", "^1.2" ou "1.0.0")`);

  const identidadeRaw = raw.identidade ?? {};
  if (!isRecord(identidadeRaw)) fail('identidade', 'deve ser um objeto');
  const identidade: ProfileIdentity = {};
  for (const key of IDENTITY_KEYS) {
    const value = (identidadeRaw as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') fail(`identidade.${key}`, 'deve ser texto');
    identidade[key] = (value as string).trim();
  }

  const { modulos, opcoesModulos } = parseModules(raw.modulos, fail);

  let canais: ChannelId[] | undefined;
  if (raw.canais !== undefined) {
    if (!Array.isArray(raw.canais) || raw.canais.length === 0) fail('canais', `deve ser uma lista não vazia (${CHANNELS.join(', ')})`);
    canais = (raw.canais as unknown[]).map((c) => String(c).trim().toLowerCase()) as ChannelId[];
    const unknown = canais.filter((c) => !CHANNELS.includes(c));
    if (unknown.length) fail('canais', `tem valores desconhecidos: ${unknown.join(', ')} (disponíveis: ${CHANNELS.join(', ')})`);
  }

  const privacidade = str(raw.privacidade) as PrivacyLevel | undefined;
  if (privacidade && !PRIVACY_LEVELS.includes(privacidade)) fail('privacidade', `deve ser ${PRIVACY_LEVELS.join(', ')}`);

  const variaveisRaw = raw.variaveis ?? {};
  if (!isRecord(variaveisRaw)) fail('variaveis', 'deve ser um mapa NOME: descrição');
  const variaveis: Record<string, string> = {};
  for (const [key, description] of Object.entries(variaveisRaw as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail(`variaveis.${key}`, 'deve ser um nome de variável em maiúsculas');
    variaveis[key] = String(description ?? '').trim();
  }

  return {
    nome: nome!,
    versao: str(raw.versao) ?? '0.0.0',
    descricao: str(raw.descricao) ?? '',
    tocador,
    identidade,
    modulos,
    opcoesModulos,
    canais,
    privacidade,
    ...(str(raw.estilo_padrao) ? { estiloPadrao: str(raw.estilo_padrao)!.toLowerCase() } : {}),
    ...(str(raw.modo_padrao) ? { modoPadrao: parseMode(str(raw.modo_padrao)) ?? fail('modo_padrao', `deve ser ${REASONING_MODES.join(', ')}`) } : {}),
    variaveis,
    ...(raw.guardrails !== undefined ? { guardrails: parseGuardrails(raw.guardrails, fail) } : {}),
  };
}

/** `modulos` aceita lista (`[voz, arquivos]`) ou mapa com opções (`voz: {}`). */
function parseModules(
  value: unknown,
  fail: (field: string, problem: string) => never,
): Pick<ProfileManifest, 'modulos' | 'opcoesModulos'> {
  let entries: Array<[string, Record<string, unknown>]>;
  if (value === undefined || value === null) entries = [];
  else if (Array.isArray(value)) entries = value.map((id) => [String(id).trim(), {}]);
  else if (isRecord(value)) {
    entries = Object.entries(value).map(([id, options]) => {
      if (options !== null && options !== undefined && !isRecord(options)) fail(`modulos.${id}`, 'deve ser um objeto de opções (ou {})');
      return [id, (options as Record<string, unknown>) ?? {}];
    });
  } else return fail('modulos', 'deve ser uma lista ou um mapa de módulos');

  for (const [id] of entries) {
    if (MODULE_IDS.includes(id)) continue;
    if (FUTURE_MODULES.has(id)) fail(`modulos.${id}`, 'ainda não está disponível neste tocador; atualize o ParreiraClaw ou remova o módulo do perfil');
    fail(`modulos.${id}`, `não existe (disponíveis: ${MODULE_IDS.join(', ')})`);
  }
  return { modulos: entries.map(([id]) => id), opcoesModulos: Object.fromEntries(entries) };
}

/** Confere a faixa de versões declarada em `requer.tocador`. Formatos: ">=1.0", ">1.0", "^1.2", "1.0.0". */
export function satisfiesVersion(version: string, range: string): boolean {
  const parsed = parseRange(range);
  const current = parseVersion(version);
  if (!parsed || !current) return false;
  const cmp = compareVersions(current, parsed.version);
  switch (parsed.op) {
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '^':
      return cmp >= 0 && current[0] === parsed.version[0];
    default:
      return cmp === 0;
  }
}

function parseRange(range: string): { op: string; version: number[] } | undefined {
  const match = /^\s*(>=|>|\^|=)?\s*(\d+(?:\.\d+){0,2})\s*$/.exec(range);
  if (!match) return undefined;
  return { op: match[1] ?? '=', version: parseVersion(match[2]!)! };
}

function parseVersion(version: string): number[] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
