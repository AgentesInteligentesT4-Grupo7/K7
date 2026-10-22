import net from 'node:net';
import { load as parseYaml } from 'js-yaml';
import { isBlockedAddress } from '../../net/NetworkGuard.js';

/** Erro numa ferramenta declarada (`ferramentas/<nome>.yaml`), apontando o arquivo e o campo. */
export class HttpToolSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpToolSpecError';
  }
}

export type ParamType = 'string' | 'number' | 'integer' | 'boolean';

export interface HttpToolParam {
  tipo: ParamType;
  descricao: string;
  opcional: boolean;
  opcoes?: string[];
}

export interface HttpToolAuth {
  tipo: 'header' | 'query' | 'bearer';
  /** Nome do cabeçalho ou do parâmetro de query (não usado em bearer). */
  nome?: string;
  /** Variável do .env do perfil com a chave. */
  variavel: string;
}

/** Ferramenta HTTP declarada pelo perfil (spec profiles-modules RF-13). */
export interface HttpToolSpec {
  nome: string;
  descricao: string;
  metodo: 'GET' | 'POST';
  url: string;
  hostsPermitidos: string[];
  parametros: Record<string, HttpToolParam>;
  fixos: Record<string, string>;
  autenticacao?: HttpToolAuth;
  campos?: string[];
  limiteBytes: number;
  timeoutMs: number;
}

const NAME = /^[a-z][a-z0-9_]{2,47}$/;
const PARAM_TYPES: ParamType[] = ['string', 'number', 'integer', 'boolean'];
const MAX_LIMIT_KB = 500;

export function parseHttpToolSpec(text: string, source: string): HttpToolSpec {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new HttpToolSpecError(`${source}: YAML inválido (${(error as Error).message.split('\n')[0]})`);
  }
  if (!isRecord(raw)) throw new HttpToolSpecError(`${source}: o arquivo deve ser um objeto YAML`);
  const fail = (field: string, problem: string): never => {
    throw new HttpToolSpecError(`${source}: campo "${field}" ${problem}`);
  };

  const nome = str(raw.nome) ?? fail('nome', 'é obrigatório');
  if (!NAME.test(nome)) fail('nome', 'deve ter só letras minúsculas, números e "_" (ex.: previsao_do_tempo)');
  const descricao = str(raw.descricao) ?? fail('descricao', 'é obrigatório (é o que o LLM lê para decidir usar a ferramenta)');
  const metodo = (str(raw.metodo) ?? 'GET').toUpperCase();
  if (metodo !== 'GET' && metodo !== 'POST') fail('metodo', 'deve ser GET ou POST');

  const urlText = str(raw.url) ?? fail('url', 'é obrigatório');
  let url: URL;
  try {
    // Marcadores {param} só no caminho: troca por um valor neutro só para validar.
    url = new URL(urlText.replace(/\{[a-z_][a-z0-9_]*\}/gi, 'x'));
  } catch {
    return fail('url', `não é uma URL válida: ${urlText}`);
  }
  if (url.protocol !== 'https:') fail('url', 'deve usar https://');
  if (url.username || url.password) fail('url', 'não pode conter usuário/senha (use "autenticacao")');
  const authority = urlText.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] ?? '';
  if (/[{}]/.test(authority)) fail('url', 'não pode ter marcadores {param} no endereço do servidor');
  const host = url.hostname.toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, '')) && isBlockedAddress(host.replace(/^\[|\]$/g, ''))) fail('url', 'aponta para um endereço interno');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) fail('url', 'aponta para a rede local');

  const hostsPermitidos = raw.hosts_permitidos === undefined ? [host] : list(raw.hosts_permitidos).map((h) => h.toLowerCase());
  if (!hostsPermitidos.includes(host)) fail('hosts_permitidos', `não inclui o host da url (${host})`);

  const parametros: Record<string, HttpToolParam> = {};
  const paramsRaw = raw.parametros ?? {};
  if (!isRecord(paramsRaw)) fail('parametros', 'deve ser um mapa nome: { tipo, descricao }');
  for (const [key, spec] of Object.entries(paramsRaw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`parametros.${key}`, 'nome inválido');
    if (!isRecord(spec)) fail(`parametros.${key}`, 'deve ser um objeto { tipo, descricao }');
    const s = spec as Record<string, unknown>;
    const tipo = (str(s.tipo) ?? 'string') as ParamType;
    if (!PARAM_TYPES.includes(tipo)) fail(`parametros.${key}.tipo`, `deve ser ${PARAM_TYPES.join(', ')}`);
    const opcoes = s.opcoes === undefined ? undefined : list(s.opcoes);
    parametros[key] = { tipo, descricao: str(s.descricao) ?? '', opcional: s.opcional === true, ...(opcoes ? { opcoes } : {}) };
  }
  for (const placeholder of urlText.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const param = parametros[placeholder[1]!];
    if (!param) fail('url', `usa {${placeholder[1]}}, que não está em "parametros"`);
    if (param!.opcional) fail(`parametros.${placeholder[1]}`, 'é usado na url e não pode ser opcional');
  }

  const fixosRaw = raw.fixos ?? {};
  if (!isRecord(fixosRaw)) fail('fixos', 'deve ser um mapa nome: valor');
  const fixos = Object.fromEntries(Object.entries(fixosRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));

  let autenticacao: HttpToolAuth | undefined;
  if (raw.autenticacao !== undefined) {
    if (!isRecord(raw.autenticacao)) fail('autenticacao', 'deve ser { tipo, nome, variavel }');
    const a = raw.autenticacao as Record<string, unknown>;
    const tipo = str(a.tipo) ?? 'header';
    if (!['header', 'query', 'bearer'].includes(tipo)) fail('autenticacao.tipo', 'deve ser header, query ou bearer');
    const variavel = str(a.variavel) ?? fail('autenticacao.variavel', 'é obrigatório (a chave fica no .env do perfil)');
    if (!/^[A-Z][A-Z0-9_]*$/.test(variavel)) fail('autenticacao.variavel', 'deve ser um nome de variável em maiúsculas');
    const nomeAuth = str(a.nome);
    if (tipo !== 'bearer' && !nomeAuth) fail('autenticacao.nome', `é obrigatório para o tipo ${tipo}`);
    autenticacao = { tipo: tipo as HttpToolAuth['tipo'], variavel, ...(nomeAuth ? { nome: nomeAuth } : {}) };
  }

  const resposta = raw.resposta ?? {};
  if (!isRecord(resposta)) fail('resposta', 'deve ser { campos, limite_kb }');
  const r = resposta as Record<string, unknown>;
  const campos = r.campos === undefined ? undefined : list(r.campos);
  const limiteKb = r.limite_kb === undefined ? 100 : Number(r.limite_kb);
  if (!Number.isFinite(limiteKb) || limiteKb <= 0 || limiteKb > MAX_LIMIT_KB) fail('resposta.limite_kb', `deve ficar entre 1 e ${MAX_LIMIT_KB}`);

  return {
    nome,
    descricao,
    metodo: metodo as 'GET' | 'POST',
    url: urlText,
    hostsPermitidos,
    parametros,
    fixos,
    autenticacao,
    campos,
    limiteBytes: Math.round(limiteKb * 1024),
    timeoutMs: 15_000,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((item) => String(item).trim()).filter(Boolean);
}
