import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessRunner } from '../utils/ProcessRunner.js';
import { readManifest } from './ProfileLoader.js';
import { PROFILE_NAME_PATTERN, ProfileError, type ProfileManifest, satisfiesVersion } from './ProfileManifest.js';
import { extractTarball } from './TarballReader.js';

export type SourceKind = 'pasta' | 'git' | 'npm';

export interface ProfileSource {
  kind: SourceKind;
  /** Pasta absoluta, URL Git ou especificação npm. */
  location: string;
  /** URLs tentadas em seguida se a primeira não existir (atalho do GitHub: `perfil-<nome>` → `<nome>`). */
  alternatives?: string[];
  /** Texto digitado pelo usuário (vai para o registro). */
  input: string;
}

export interface InstalledRecord {
  nome: string;
  origem: string;
  tipo: SourceKind;
  versao: string;
  commit?: string;
  instaladoEm: string;
  atualizadoEm?: string;
}

/** Extensões e arquivos que um perfil não pode trazer (RF-10): perfis são conteúdo, nunca código. */
const FORBIDDEN_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.pyw', '.rb', '.pl', '.php', '.lua',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.vbs', '.wsf', '.com',
  '.exe', '.dll', '.so', '.dylib', '.msi', '.scr', '.jar', '.class', '.wasm', '.node', '.apk', '.app',
]);
const FORBIDDEN_NAMES = new Set(['package.json', 'makefile', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.npmrc', '.gitmodules']);
/** Pastas que não fazem parte do conteúdo do perfil. */
const SKIPPED_DIRS = new Set(['.git', 'dados', 'node_modules']);
const MAX_PROFILE_BYTES = 100 * 1024 * 1024;
const NPM_SPEC = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*(@[a-z0-9.^~<>=*-]+)?$/i;
const GITHUB_SHORTCUT = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

/** Interpreta a origem (spec RF-04): pasta local, URL Git, atalho `usuario/nome` do GitHub ou `@escopo/nome` do npm. */
export function parseSource(input: string, cwd = process.cwd()): ProfileSource {
  const text = input.trim();
  const local = path.resolve(cwd, text);
  if (fs.existsSync(local) && fs.statSync(local).isDirectory()) return { kind: 'pasta', location: local, input: text };
  if (/^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(text)) return { kind: 'git', location: text, input: text };
  if (text.startsWith('@')) {
    if (!NPM_SPEC.test(text)) throw new ProfileError(`Pacote npm inválido: "${text}" (use @escopo/nome ou @escopo/nome@versão)`);
    return { kind: 'npm', location: text, input: text };
  }
  const github = GITHUB_SHORTCUT.exec(text);
  if (github) {
    const [, user, name] = github as unknown as [string, string, string];
    const url = (repo: string) => `https://github.com/${user}/${repo}.git`;
    if (name.startsWith('perfil-')) return { kind: 'git', location: url(name), input: text };
    return { kind: 'git', location: url(`perfil-${name}`), alternatives: [url(name)], input: text };
  }
  throw new ProfileError(`Origem não reconhecida: "${text}". Use uma pasta, uma URL Git, usuario/nome (GitHub) ou @escopo/nome (npm).`);
}

/** Lista os arquivos proibidos (código, links) de uma pasta de perfil; vazia = aprovada. */
export function findForbiddenFiles(dir: string): string[] {
  const problems: string[] = [];
  let total = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        problems.push(`${rel} (link simbólico)`);
      } else if (entry.isDirectory()) {
        if (!(current === dir && SKIPPED_DIRS.has(entry.name))) walk(full);
      } else if (FORBIDDEN_NAMES.has(entry.name.toLowerCase()) || FORBIDDEN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        problems.push(rel);
      } else {
        total += fs.statSync(full).size;
      }
    }
  };
  walk(dir);
  if (total > MAX_PROFILE_BYTES) problems.push(`(tamanho total ${Math.round(total / 1024 / 1024)} MB acima do limite de ${MAX_PROFILE_BYTES / 1024 / 1024} MB)`);
  return problems;
}

export interface InstallerOptions {
  /** Pasta onde os perfis ficam (a primeira de PERFIS_DIR). */
  profilesDir: string;
  playerVersion: string;
  runner?: ProcessRunner;
  /** Caminho do npm-cli.js (npm_execpath), para rodar o npm sem shell. */
  npmCliPath?: string;
  log?: (line: string) => void;
}

export interface InstallResult {
  name: string;
  dir: string;
  manifest: ProfileManifest;
  /** Variáveis do manifesto ainda vazias no .env do perfil. */
  pendingVariables: string[];
}

/** Instala, atualiza e remove perfis. Nunca executa nada que venha do perfil (RF-10). */
export class ProfileInstaller {
  private readonly runner: ProcessRunner;
  private readonly log: (line: string) => void;

  constructor(private readonly options: InstallerOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.log = options.log ?? (() => undefined);
  }

  get registryPath(): string {
    return path.join(this.options.profilesDir, '.instalados.json');
  }

  readRegistry(): Record<string, InstalledRecord> {
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as Record<string, InstalledRecord>;
    } catch {
      return {};
    }
  }

  async install(input: string, options: { name?: string } = {}): Promise<InstallResult> {
    const source = parseSource(input);
    this.log(`📥 Origem: ${source.kind} → ${source.location}`);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-'));
    try {
      const commit = await this.fetch(source, staging);
      const manifest = this.validate(staging);
      const name = options.name ?? manifest.nome;
      if (!PROFILE_NAME_PATTERN.test(name)) throw new ProfileError(`Nome de perfil inválido: "${name}"`);
      const dir = path.join(this.options.profilesDir, name);
      if (fs.existsSync(dir)) throw new ProfileError(`Já existe um perfil "${name}" em ${dir}. Use "atualizar ${name}" ou --nome <outro>.`);

      fs.mkdirSync(this.options.profilesDir, { recursive: true });
      fs.cpSync(staging, dir, { recursive: true });
      this.writeRecord(name, { nome: name, origem: source.input, tipo: source.kind, versao: manifest.versao, commit, instaladoEm: new Date().toISOString() });
      return { name, dir, manifest, pendingVariables: this.prepareEnv(dir, manifest) };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Busca a nova versão na origem registrada; se for inválida ou incompatível, mantém a atual. */
  async update(name: string): Promise<InstallResult> {
    const dir = path.join(this.options.profilesDir, name);
    const record = this.readRegistry()[name];
    if (!fs.existsSync(path.join(dir, 'perfil.yaml'))) throw new ProfileError(`Perfil "${name}" não encontrado em ${this.options.profilesDir}`);
    if (!record) throw new ProfileError(`O perfil "${name}" não foi instalado pelo instalador (sem origem registrada); atualize-o manualmente.`);

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-'));
    try {
      const commit = await this.fetch(parseSource(record.origem), staging);
      const manifest = this.validate(staging);
      // Troca só o conteúdo: .env e dados do perfil ficam intactos.
      for (const entry of fs.readdirSync(dir)) {
        if (entry === '.env' || SKIPPED_DIRS.has(entry)) continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
      fs.cpSync(staging, dir, { recursive: true, force: true });
      this.writeRecord(name, { ...record, versao: manifest.versao, commit, atualizadoEm: new Date().toISOString() });
      this.log(`🔄 ${name}: ${record.versao} → ${manifest.versao}`);
      return { name, dir, manifest, pendingVariables: this.prepareEnv(dir, manifest) };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Remove a pasta do perfil (e os dados, só se pedido). Confirmação é responsabilidade da CLI. */
  remove(name: string, options: { dataDir?: string } = {}): void {
    const dir = path.join(this.options.profilesDir, name);
    if (!fs.existsSync(path.join(dir, 'perfil.yaml'))) throw new ProfileError(`Perfil "${name}" não encontrado em ${this.options.profilesDir}`);
    fs.rmSync(dir, { recursive: true, force: true });
    if (options.dataDir) fs.rmSync(options.dataDir, { recursive: true, force: true });
    const registry = this.readRegistry();
    delete registry[name];
    this.saveRegistry(registry);
  }

  /** Copia a origem para `staging` e devolve o commit (Git). */
  private async fetch(source: ProfileSource, staging: string): Promise<string | undefined> {
    if (source.kind === 'pasta') {
      fs.cpSync(source.location, staging, {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(source.location, src);
          const top = rel.split(path.sep)[0] ?? '';
          return !SKIPPED_DIRS.has(top) && path.basename(src) !== '.env';
        },
      });
      return undefined;
    }
    if (source.kind === 'git') {
      // Clonar não executa nada do repositório (hooks não vêm no clone).
      const urls = [source.location, ...(source.alternatives ?? [])];
      const failures: string[] = [];
      for (const url of urls) {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        const clone = await this.runner.run(
          'git',
          ['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--depth', '1', '--quiet', '--no-recurse-submodules', '--', url, staging],
          120_000,
        );
        if (clone.code === 0) {
          if (url !== source.location) this.log(`   (encontrado em ${url})`);
          failures.length = 0;
          break;
        }
        failures.push(`${url}: ${clone.stderr.trim().split('\n').pop() ?? 'erro desconhecido'}`);
      }
      if (failures.length) throw new ProfileError(`git clone falhou:\n  ${failures.join('\n  ')}`);
      const head = await this.runner.run('git', ['-C', staging, 'rev-parse', 'HEAD'], 10_000);
      fs.rmSync(path.join(staging, '.git'), { recursive: true, force: true });
      return head.stdout.trim() || undefined;
    }
    return this.fetchNpm(source.location, staging);
  }

  /** `npm pack --ignore-scripts` baixa o .tgz sem rodar scripts; o package.json do pacote é descartado. */
  private async fetchNpm(spec: string, staging: string): Promise<undefined> {
    const npmCli = this.options.npmCliPath;
    if (!npmCli) throw new ProfileError('Para instalar do npm, rode pelo npm: "npm run perfil -- instalar @escopo/nome"');
    const download = fs.mkdtempSync(path.join(os.tmpdir(), 'perfil-npm-'));
    try {
      const pack = await this.runner.run(process.execPath, [npmCli, 'pack', spec, '--ignore-scripts', '--pack-destination', download, '--json'], 120_000);
      if (pack.code !== 0) throw new ProfileError(`npm pack falhou: ${pack.stderr.trim().split('\n').pop() ?? 'erro desconhecido'}`);
      const tgz = fs.readdirSync(download).find((f) => f.endsWith('.tgz'));
      if (!tgz) throw new ProfileError('npm pack não gerou o pacote');
      extractTarball(path.join(download, tgz), staging, { stripPrefix: 'package/' });
      fs.rmSync(path.join(staging, 'package.json'), { force: true });
      return undefined;
    } finally {
      fs.rmSync(download, { recursive: true, force: true });
    }
  }

  private validate(dir: string): ProfileManifest {
    const forbidden = findForbiddenFiles(dir);
    if (forbidden.length) {
      throw new ProfileError(`Perfil recusado: perfis não podem conter código nem links (RF-10). Arquivos proibidos:\n  ${forbidden.join('\n  ')}`);
    }
    const manifest = readManifest(dir);
    if (manifest.tocador && !satisfiesVersion(this.options.playerVersion, manifest.tocador)) {
      throw new ProfileError(`O perfil "${manifest.nome}" requer o tocador ${manifest.tocador}, mas este é o ${this.options.playerVersion}.`);
    }
    return manifest;
  }

  /** Cria o .env do perfil a partir do .env.example (sem sobrescrever) e lista o que falta preencher. */
  private prepareEnv(dir: string, manifest: ProfileManifest): string[] {
    const envFile = path.join(dir, '.env');
    const example = path.join(dir, '.env.example');
    if (!fs.existsSync(envFile)) {
      const content = fs.existsSync(example)
        ? fs.readFileSync(example, 'utf8')
        : Object.entries(manifest.variaveis).map(([key, description]) => `# ${description}\n${key}=\n`).join('\n');
      fs.writeFileSync(envFile, content);
    }
    const values = fs.readFileSync(envFile, 'utf8');
    return Object.keys(manifest.variaveis).filter((key) => !new RegExp(`^${key}=\\s*\\S`, 'm').test(values));
  }

  private writeRecord(name: string, record: InstalledRecord): void {
    this.saveRegistry({ ...this.readRegistry(), [name]: record });
  }

  private saveRegistry(registry: Record<string, InstalledRecord>): void {
    fs.mkdirSync(this.options.profilesDir, { recursive: true });
    fs.writeFileSync(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
}
