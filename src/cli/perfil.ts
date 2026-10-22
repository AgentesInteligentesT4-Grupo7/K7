import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { errorMessage } from '../errors/AppErrors.js';
import { ProfileInstaller } from '../profiles/ProfileInstaller.js';
import { listProfiles, playerVersion, profileDirs, readManifest } from '../profiles/ProfileLoader.js';
import type { ProfileManifest } from '../profiles/ProfileManifest.js';
import { createProfile } from '../profiles/ProfileTemplate.js';

const USAGE = `Uso: npm run perfil -- <comando>

  novo <nome>                     cria um perfil vazio a partir do modelo
  instalar <origem> [--nome x]    instala uma fita. Origens:
                                    ./pasta/local
                                    https://github.com/usuario/perfil-promo
                                    usuario/promo        (GitHub: tenta usuario/perfil-promo e depois usuario/promo)
                                    @escopo/promo        (pacote npm, baixado sem executar scripts)
  listar                          perfis encontrados em PERFIS_DIR
  info <nome>                     manifesto e variáveis pendentes
  atualizar <nome>                busca a versão nova na origem (mantém .env e dados)
  remover <nome> [--apagar-dados] remove o perfil (pede confirmação)

Rodar um perfil: npm run dev -- --perfil <nome>  |  npm run chat -- --perfil <nome>`;

const rootDir = process.cwd();
const dirs = profileDirs(process.env, rootDir);
const version = playerVersion(rootDir);
const installer = new ProfileInstaller({
  profilesDir: dirs[0]!,
  playerVersion: version,
  npmCliPath: process.env.npm_execpath,
  log: (line) => console.log(line),
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, target] = args;
  const option = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  switch (command) {
    case 'novo': {
      if (!target) return fail('Informe o nome: npm run perfil -- novo <nome>');
      const dir = createProfile(dirs[0]!, target, version);
      console.log(`✅ Perfil criado em ${dir}\n   Edite perfil.yaml e as skills; depois: npm run chat -- --perfil ${target}`);
      return;
    }
    case 'instalar': {
      if (!target) return fail('Informe a origem: npm run perfil -- instalar <origem>');
      const result = await installer.install(target, { name: option('nome') });
      console.log(`\n✅ Perfil "${result.name}" instalado em ${result.dir}`);
      printSummary(result.manifest);
      printPending(result.dir, result.pendingVariables, result.manifest);
      return;
    }
    case 'listar': {
      const profiles = listProfiles(dirs);
      const registry = installer.readRegistry();
      if (!profiles.length) return void console.log(`Nenhum perfil em ${dirs.join(', ')}. Crie com: npm run perfil -- novo <nome>`);
      for (const p of profiles) {
        if (!p.manifest) {
          console.log(`❌ ${p.name}: ${p.error}`);
          continue;
        }
        const origin = registry[p.name] ? ` · origem: ${registry[p.name]!.origem}` : '';
        console.log(`${p.manifest.identidade.emoji ?? '•'} ${p.name} v${p.manifest.versao} — ${p.manifest.descricao}`);
        console.log(`   módulos: ${p.manifest.modulos.join(', ') || '(nenhum)'} · canais: ${(p.manifest.canais ?? ['todos']).join(', ')}${origin}`);
      }
      return;
    }
    case 'info': {
      const profile = listProfiles(dirs).find((p) => p.name === target);
      if (!profile) return fail(`Perfil "${target ?? ''}" não encontrado em ${dirs.join(', ')}`);
      const manifest = readManifest(profile.dir);
      console.log(`${profile.dir}`);
      printSummary(manifest);
      const envFile = path.join(profile.dir, '.env');
      const values = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
      printPending(profile.dir, Object.keys(manifest.variaveis).filter((k) => !new RegExp(`^${k}=\\s*\\S`, 'm').test(values)), manifest);
      return;
    }
    case 'atualizar': {
      if (!target) return fail('Informe o nome: npm run perfil -- atualizar <nome>');
      const result = await installer.update(target);
      console.log(`✅ Perfil "${result.name}" atualizado (v${result.manifest.versao})`);
      printPending(result.dir, result.pendingVariables, result.manifest);
      return;
    }
    case 'remover': {
      if (!target) return fail('Informe o nome: npm run perfil -- remover <nome>');
      const eraseData = args.includes('--apagar-dados');
      const dataDir = path.join(rootDir, 'dados', target);
      console.log(`Vai apagar ${path.join(dirs[0]!, target)}${eraseData ? ` e os dados em ${dataDir}` : ` (os dados em ${dataDir} ficam)`}.`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Digite o nome do perfil para confirmar: `);
      rl.close();
      if (answer.trim() !== target) return fail('Cancelado.');
      installer.remove(target, { dataDir: eraseData ? dataDir : undefined });
      console.log(`🗑️ Perfil "${target}" removido.`);
      return;
    }
    default:
      console.log(USAGE);
      if (command && command !== 'ajuda' && command !== '--help') process.exitCode = 1;
  }
}

function printSummary(manifest: ProfileManifest): void {
  const id = manifest.identidade;
  console.log(`   ${id.emoji ?? ''} ${id.nome ?? manifest.nome} v${manifest.versao} — ${manifest.descricao}`);
  console.log(`   módulos: ${manifest.modulos.join(', ') || '(nenhum)'} · canais: ${(manifest.canais ?? ['todos']).join(', ')} · privacidade: ${manifest.privacidade ?? 'padrão'}`);
}

function printPending(dir: string, pending: string[], manifest: ProfileManifest): void {
  if (!pending.length) return void console.log(`   Pronto para rodar: npm run chat -- --perfil ${path.basename(dir)}`);
  console.log(`\n📝 Preencha em ${path.join(dir, '.env')}:`);
  for (const key of pending) console.log(`   ${key}: ${manifest.variaveis[key] || ''}`);
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`❌ ${errorMessage(error)}`);
  process.exitCode = 1;
});
