import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { Config } from '../config/Config.js';
import { DEFAULT_CHANNELS } from '../modules/registry.js';
import { ProfileError, type ProfileManifest, parseManifest, satisfiesVersion } from './ProfileManifest.js';

export interface LoadedProfile {
  name: string;
  /** Pasta do perfil (onde estão perfil.yaml, skills/, evals/ e .env). */
  dir: string;
  manifest: ProfileManifest;
}

/**
 * Variáveis do `.env` raiz que nunca passam para um perfil: cada perfil tem a própria identidade
 * e o próprio bot (dois processos com o mesmo token brigam pelo polling — 409).
 */
const NOT_INHERITED = ['TELEGRAM_BOT_TOKEN', 'AGENT_NAME', 'AGENT_EMOJI', 'OWNER_NAME', 'AGENT_PURPOSE', 'AGENT_INSTRUCTIONS', 'AGENT_LANGUAGE'];

/** Pastas onde os perfis são procurados (PERFIS_DIR, separadas por vírgula; padrão ./perfis). */
export function profileDirs(env: NodeJS.ProcessEnv, rootDir: string): string[] {
  return (env.PERFIS_DIR?.trim() || './perfis')
    .split(',')
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.resolve(rootDir, dir));
}

/** Versão do tocador (package.json da raiz). */
export function playerVersion(rootDir: string): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Lista os perfis encontrados (manifesto inválido aparece com o erro, sem derrubar a listagem). */
export function listProfiles(dirs: string[]): Array<{ name: string; dir: string; manifest?: ProfileManifest; error?: string }> {
  const found = new Map<string, { name: string; dir: string; manifest?: ProfileManifest; error?: string }>();
  for (const base of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(base, entry.name);
      if (!entry.isDirectory() || found.has(entry.name) || !fs.existsSync(path.join(dir, 'perfil.yaml'))) continue;
      try {
        found.set(entry.name, { name: entry.name, dir, manifest: readManifest(dir) });
      } catch (error) {
        found.set(entry.name, { name: entry.name, dir, error: (error as Error).message });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readManifest(dir: string): ProfileManifest {
  const file = path.join(dir, 'perfil.yaml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ProfileError(`Perfil sem manifesto: ${file} não encontrado`);
  }
  return parseManifest(text, file);
}

/** Localiza e valida um perfil pelo nome (a primeira pasta de PERFIS_DIR que o tiver vence). */
export function loadProfile(name: string, dirs: string[], version: string): LoadedProfile {
  const dir = dirs.map((base) => path.join(base, name)).find((candidate) => fs.existsSync(path.join(candidate, 'perfil.yaml')));
  if (!dir) {
    const available = listProfiles(dirs).map((p) => p.name);
    throw new ProfileError(
      `Perfil "${name}" não encontrado em ${dirs.join(', ')}.` +
        (available.length ? ` Disponíveis: ${available.join(', ')}.` : ' Crie um com "npm run perfil -- novo <nome>" ou ajuste PERFIS_DIR.'),
    );
  }
  // O nome da pasta é o nome do perfil (permite instalar a mesma fita duas vezes com --nome).
  const manifest = readManifest(dir);
  if (manifest.tocador && !satisfiesVersion(version, manifest.tocador)) {
    throw new ProfileError(`O perfil "${name}" requer o tocador ${manifest.tocador}, mas este é o ${version}. Atualize o ParreiraClaw.`);
  }
  return { name, dir, manifest };
}

/**
 * Ambiente efetivo de um perfil (RF-07), da menor para a maior precedência:
 * `.env` raiz (sem identidade e token do bot) → pastas isoladas por perfil → manifesto → `.env` do perfil.
 */
export function buildProfileEnv(baseEnv: NodeJS.ProcessEnv, rootDir: string, profile: LoadedProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of NOT_INHERITED) delete env[key];

  // DADOS_DIR: raiz dos dados por perfil (no Docker, dentro do volume /app/state).
  const dataRoot = path.resolve(rootDir, baseEnv.DADOS_DIR?.trim() || 'dados');
  const data = (...parts: string[]) => path.join(dataRoot, profile.name, ...parts);
  Object.assign(env, {
    DB_PATH: data('agente.db'),
    VOICE_CLONE_DIR: data('vozes'),
    TMP_DIR: path.join(rootDir, 'tmp', profile.name),
    WORKSPACE_DIR: path.join(rootDir, 'workspace', profile.name),
    SKILLS_DIR: path.join(profile.dir, 'skills'),
    FERRAMENTAS_DIR: path.join(profile.dir, 'ferramentas'),
  });

  const { manifest } = profile;
  const fromManifest: Record<string, string | undefined> = {
    AGENT_NAME: manifest.identidade.nome,
    AGENT_EMOJI: manifest.identidade.emoji,
    OWNER_NAME: manifest.identidade.dono,
    AGENT_PURPOSE: manifest.identidade.proposito,
    AGENT_INSTRUCTIONS: manifest.identidade.instrucoes,
    AGENT_LANGUAGE: manifest.identidade.idioma,
    MODULES: manifest.modulos.join(','),
    CHANNELS: manifest.canais?.join(','),
    PRIVACY_DEFAULT: manifest.privacidade,
  };
  for (const [key, value] of Object.entries(fromManifest)) if (value !== undefined) env[key] = value;

  const envFile = path.join(profile.dir, '.env');
  if (fs.existsSync(envFile)) {
    // Caminhos relativos do .env do perfil são relativos ao tocador (onde o processo roda).
    // Linha vazia (ex.: "TELEGRAM_ALLOWED_USER_IDS=" vindo do .env.example) não apaga o valor herdado.
    for (const [key, value] of Object.entries(parseDotenv(fs.readFileSync(envFile)))) {
      if (value.trim()) env[key] = value;
    }
  }
  env.PERFIL_NOME = profile.name;
  env.PERFIL_DIR = profile.dir;
  return env;
}

/** Variáveis exigidas que ficaram vazias: as do manifesto e, se o canal Telegram for usado, as dele. */
export function missingVariables(profile: LoadedProfile, env: NodeJS.ProcessEnv, telegram: boolean): string[] {
  const required = new Set(Object.keys(profile.manifest.variaveis));
  if (telegram) for (const key of Object.keys(DEFAULT_DESCRIPTIONS)) required.add(key);
  return [...required].filter((key) => !env[key]?.trim() && (telegram || !key.startsWith('TELEGRAM_')));
}

/** `--perfil <nome>` na linha de comando, ou PERFIL / PERFIL_PADRAO no ambiente. */
export function selectedProfile(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const index = argv.indexOf('--perfil');
  if (index >= 0) {
    const name = argv[index + 1];
    if (!name || name.startsWith('--')) throw new ProfileError('Informe o nome do perfil: --perfil <nome>');
    return name;
  }
  const inline = argv.find((arg) => arg.startsWith('--perfil='));
  if (inline) return inline.slice('--perfil='.length);
  return env.PERFIL?.trim() || env.PERFIL_PADRAO?.trim() || undefined;
}

export interface ConfigOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  /** O terminal e o eval não precisam do Telegram (padrão: exige se o canal estiver ligado). */
  requireTelegram?: boolean;
}

/**
 * Config do processo: sem perfil, o `.env` raiz como sempre (RNF-03);
 * com perfil, o ambiente mesclado e validado contra o manifesto.
 */
export function loadConfig(options: ConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? process.cwd();
  const name = selectedProfile(options.argv ?? process.argv.slice(2), env);
  if (!name) return new Config(env, rootDir, { requireTelegram: options.requireTelegram });

  const profile = loadProfile(name, profileDirs(env, rootDir), playerVersion(rootDir));
  const profileEnv = buildProfileEnv(env, rootDir, profile);
  const telegram = options.requireTelegram ?? (profile.manifest.canais ?? DEFAULT_CHANNELS).includes('telegram');
  const missing = missingVariables(profile, profileEnv, telegram);
  if (missing.length) {
    const lines = missing.map((key) => `  ${key}: ${profile.manifest.variaveis[key] || DEFAULT_DESCRIPTIONS[key] || '(sem descrição)'}`);
    throw new ProfileError(`Preencha em ${path.join(profile.dir, '.env')}:\n${lines.join('\n')}`);
  }
  return new Config(profileEnv, rootDir, { requireTelegram: telegram });
}

const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'token do bot deste perfil (@BotFather); cada perfil usa um bot próprio',
  TELEGRAM_ALLOWED_USER_IDS: 'IDs do Telegram autorizados, separados por vírgula',
};
