import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it } from 'node:test';
import { AgentController } from '../src/agent/AgentController.js';
import { Config } from '../src/config/Config.js';
import { ModuleDisabledError } from '../src/errors/AppErrors.js';
import { moduleSkillDirs } from '../src/modules/registry.js';
import { ProfileInstaller, findForbiddenFiles, parseSource } from '../src/profiles/ProfileInstaller.js';
import { buildProfileEnv, listProfiles, loadConfig, loadProfile, selectedProfile } from '../src/profiles/ProfileLoader.js';
import { ProfileError, parseManifest, satisfiesVersion } from '../src/profiles/ProfileManifest.js';
import { createProfile } from '../src/profiles/ProfileTemplate.js';
import { extractTarball } from '../src/profiles/TarballReader.js';
import { SkillLoader } from '../src/skills/SkillLoader.js';
import { ToolFactory } from '../src/tools/ToolFactory.js';
import { DisabledSpeechToText } from '../src/voice/stt/DisabledSpeechToText.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perfis-test-'));

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
}

const MANIFEST = `nome: promo
versao: 0.2.0
descricao: Curadoria de promoções
requer: { tocador: ">=1.0" }
identidade:
  nome: PromoBot
  emoji: 🛒
  dono: Equipe
  proposito: curador de promoções
modulos: [arquivos]
canais: [terminal]
privacidade: publico
variaveis:
  AFILIADO_ID: ID de afiliado
`;

/** Tocador falso: package.json com versão + pasta de perfis com o perfil "promo". */
function setupPlayer(manifest = MANIFEST, profileEnv = 'AFILIADO_ID=abc\nTELEGRAM_ALLOWED_USER_IDS=\n') {
  const root = tmpDir();
  writeFiles(root, {
    'package.json': '{"version":"1.0.0"}',
    'modulos/arquivos/skills/gestor-arquivos/SKILL.md': '---\nname: gestor-arquivos\ndescription: do módulo\n---\nmódulo',
    'perfis/promo/perfil.yaml': manifest,
    'perfis/promo/skills/curadoria/SKILL.md': '---\nname: curadoria\ndescription: Curadoria\n---\nSou {{AGENT_NAME}}.',
    'perfis/promo/.env': profileEnv,
  });
  return root;
}

const ROOT_ENV = {
  TELEGRAM_BOT_TOKEN: 'token-do-pessoal',
  TELEGRAM_ALLOWED_USER_IDS: '1',
  GEMINI_API_KEY: 'k',
  AGENT_NAME: 'ParreiraClaw',
  DB_PATH: './data/parreiraclaw.db',
  PERFIS_DIR: './perfis',
};

describe('Manifesto do perfil (perfil.yaml)', () => {
  it('lê identidade, módulos (lista ou mapa), canais, privacidade e variáveis', () => {
    const m = parseManifest(MANIFEST);
    assert.equal(m.nome, 'promo');
    assert.equal(m.identidade.nome, 'PromoBot');
    assert.deepEqual(m.modulos, ['arquivos']);
    assert.deepEqual(m.canais, ['terminal']);
    assert.deepEqual(m.variaveis, { AFILIADO_ID: 'ID de afiliado' });
    const withOptions = parseManifest('nome: x\nmodulos:\n  voz: {}\n  refinamento: { rodadas: 3 }\n');
    assert.deepEqual(withOptions.modulos, ['voz', 'refinamento']);
    assert.deepEqual(withOptions.opcoesModulos.refinamento, { rodadas: 3 });
  });

  it('erros apontam o campo e explicam o que fazer', () => {
    assert.throws(() => parseManifest('versao: 1'), /campo "nome" é obrigatório/);
    assert.throws(() => parseManifest('nome: Promo Bot'), /letras minúsculas/);
    assert.throws(() => parseManifest('nome: x\nmodulos: [teleporte]'), /modulos.teleporte" não existe/);
    assert.throws(() => parseManifest('nome: x\nmodulos: [imagens]'), /ainda não está disponível neste tocador/);
    assert.throws(() => parseManifest('nome: x\ncanais: [whatsapp]'), /canais" tem valores desconhecidos/);
    assert.throws(() => parseManifest('nome: x\nprivacidade: secreta'), /privacidade/);
    assert.throws(() => parseManifest('nome: [x'), ProfileError);
  });

  it('faixas de versão do tocador', () => {
    assert.ok(satisfiesVersion('1.0.0', '>=1.0'));
    assert.ok(!satisfiesVersion('1.0.0', '>=1.2'));
    assert.ok(satisfiesVersion('1.4.1', '^1.2'));
    assert.ok(!satisfiesVersion('2.0.0', '^1.2'));
    assert.ok(satisfiesVersion('1.0.0', '1.0.0'));
    assert.throws(() => parseManifest('nome: x\nrequer: { tocador: "qualquer" }'), /faixa inválida/);
  });
});

describe('Carregamento de perfil', () => {
  it('--perfil, --perfil=, PERFIL e PERFIL_PADRAO', () => {
    assert.equal(selectedProfile(['--perfil', 'promo'], {}), 'promo');
    assert.equal(selectedProfile(['--verbose', '--perfil=historias'], {}), 'historias');
    assert.equal(selectedProfile([], { PERFIL: 'a', PERFIL_PADRAO: 'b' }), 'a');
    assert.equal(selectedProfile([], { PERFIL_PADRAO: 'b' }), 'b');
    assert.equal(selectedProfile([], {}), undefined);
    assert.throws(() => selectedProfile(['--perfil'], {}), /Informe o nome/);
  });

  it('ambiente mesclado: isola dados, não herda token nem identidade, manifesto e .env do perfil vencem', () => {
    const root = setupPlayer();
    const profile = loadProfile('promo', [path.join(root, 'perfis')], '1.0.0');
    const env = buildProfileEnv({ ...ROOT_ENV, OLLAMA_BASE_URL: 'http://gpu:11434' }, root, profile);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(env.TELEGRAM_ALLOWED_USER_IDS, '1');
    assert.equal(env.OLLAMA_BASE_URL, 'http://gpu:11434', 'serviços comuns vêm do .env do tocador');
    assert.equal(env.AGENT_NAME, 'PromoBot');
    assert.equal(env.DB_PATH, path.join(root, 'dados', 'promo', 'agente.db'));
    assert.equal(env.WORKSPACE_DIR, path.join(root, 'workspace', 'promo'));
    assert.equal(env.TMP_DIR, path.join(root, 'tmp', 'promo'));
    assert.equal(env.MODULES, 'arquivos');
    assert.equal(env.AFILIADO_ID, 'abc');
    assert.equal(env.PERFIL_NOME, 'promo');
  });

  it('loadConfig com perfil: módulos, canais e skills em camadas (módulo → perfil)', () => {
    const root = setupPlayer();
    const config = loadConfig({ argv: ['--perfil', 'promo'], env: ROOT_ENV, rootDir: root });
    assert.equal(config.profileName, 'promo');
    assert.equal(config.identity.name, 'PromoBot');
    assert.deepEqual([...config.modules], ['arquivos']);
    assert.deepEqual([...config.channels], ['terminal']);
    assert.equal(config.telegramBotToken, '', 'perfil só de terminal não exige bot');
    assert.deepEqual(config.skillsDirs, [path.join(root, 'modulos', 'arquivos', 'skills'), path.join(root, 'perfis', 'promo', 'skills')]);
    const skills = new SkillLoader(config.skillsDirs, config.identity);
    assert.deepEqual(skills.loadAll().map((s) => s.name).sort(), ['curadoria', 'gestor-arquivos']);
    assert.match(skills.loadContent(skills.loadAll().find((s) => s.name === 'curadoria')!), /Sou PromoBot\./);
  });

  it('sem perfil, o .env raiz funciona como antes (retrocompatível)', () => {
    const config = loadConfig({ argv: [], env: ROOT_ENV, rootDir: setupPlayer() });
    assert.equal(config.profileName, undefined);
    assert.equal(config.identity.name, 'ParreiraClaw');
    assert.equal(config.modules.size, 5);
  });

  it('variável obrigatória vazia e perfil com Telegram sem bot próprio dão erro acionável', () => {
    const root = setupPlayer(MANIFEST, '');
    assert.throws(() => loadConfig({ argv: ['--perfil', 'promo'], env: ROOT_ENV, rootDir: root }), /Preencha em .*\.env:\n {2}AFILIADO_ID: ID de afiliado/s);
    const telegram = setupPlayer(MANIFEST.replace('canais: [terminal]', 'canais: [telegram]'));
    assert.throws(() => loadConfig({ argv: ['--perfil', 'promo'], env: ROOT_ENV, rootDir: telegram }), /TELEGRAM_BOT_TOKEN: token do bot deste perfil/);
  });

  it('perfil inexistente lista os disponíveis; tocador antigo explica a versão exigida', () => {
    const root = setupPlayer();
    assert.throws(() => loadProfile('outro', [path.join(root, 'perfis')], '1.0.0'), /Disponíveis: promo/);
    assert.throws(() => loadProfile('promo', [path.join(root, 'perfis')], '0.9.0'), /requer o tocador >=1.0, mas este é o 0.9.0/);
  });
});

describe('Skills em camadas', () => {
  it('a camada posterior (perfil) sobrescreve a skill de mesmo nome do módulo', () => {
    const base = tmpDir();
    writeFiles(base, {
      'modulo/resumo/SKILL.md': '---\nname: resumo\ndescription: do módulo\n---\nmódulo',
      'perfil/resumo/SKILL.md': '---\nname: resumo\ndescription: do perfil\n---\nperfil',
    });
    const loader = new SkillLoader([path.join(base, 'modulo'), path.join(base, 'perfil'), path.join(base, 'inexistente')]);
    const skills = loader.loadAll();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, 'do perfil');
    assert.equal(loader.loadContent(skills[0]!).trim(), 'perfil');
  });

  it('só módulos ligados que têm skills entram', () => {
    const root = setupPlayer();
    assert.deepEqual(moduleSkillDirs(root, ['arquivos', 'voz']), [path.join(root, 'modulos', 'arquivos', 'skills')]);
  });
});

describe('Módulos desligados', () => {
  it('sem "arquivos", só a ferramenta de data/hora', () => {
    const workspace = tmpDir();
    assert.deepEqual(new ToolFactory(workspace, { files: false }).createRegistry().list().map((t) => t.name), ['obter_data_hora']);
    assert.equal(new ToolFactory(workspace).createRegistry().size, 4);
  });

  it('sem "voz", áudio recebido é recusado com aviso e a resposta sai em texto', async () => {
    await assert.rejects(new DisabledSpeechToText().transcribe(), (e: unknown) => e instanceof ModuleDisabledError && /módulo "voz" desligado/.test(e.userMessage));
    const config = new Config({ ...ROOT_ENV, MODULES: '' });
    assert.equal(config.modules.size, 0, 'MODULES vazio desliga todos');
    assert.equal(typeof AgentController, 'function');
  });
});

describe('Instalador de perfis', () => {
  it('origens: pasta, URL Git, atalho do GitHub e npm; recusa transportes perigosos', () => {
    const dir = tmpDir();
    assert.equal(parseSource(dir).kind, 'pasta');
    assert.deepEqual(parseSource('danillotparreira/fita1'), {
      kind: 'git',
      location: 'https://github.com/danillotparreira/perfil-fita1.git',
      alternatives: ['https://github.com/danillotparreira/fita1.git'],
      input: 'danillotparreira/fita1',
    });
    assert.equal(parseSource('parreira/perfil-promo').location, 'https://github.com/parreira/perfil-promo.git');
    assert.equal(parseSource('https://github.com/x/perfil-y').kind, 'git');
    assert.deepEqual(parseSource('@parreira/promo@1.2.0'), { kind: 'npm', location: '@parreira/promo@1.2.0', input: '@parreira/promo@1.2.0' });
    assert.throws(() => parseSource('ext::sh -c touch% /tmp/x .git'), ProfileError);
    assert.throws(() => parseSource('http://inseguro.com/perfil'), ProfileError);
    assert.throws(() => parseSource('@escopo/nome; rm -rf'), /Pacote npm inválido/);
  });

  it('atalho do GitHub: sem perfil-<nome>, clona o repositório com o nome exato', async () => {
    const cloned: string[] = [];
    const runner = {
      async run(_cmd: string, args: string[]) {
        if (args.includes('rev-parse')) return { code: 0, stdout: 'abc123\n', stderr: '' };
        const [url, dest] = args.slice(-2) as [string, string];
        cloned.push(url);
        if (url.includes('perfil-fita1')) return { code: 128, stdout: '', stderr: 'remote: Repository not found.' };
        fs.writeFileSync(path.join(dest, 'perfil.yaml'), MANIFEST.replace('nome: promo', 'nome: fita1'));
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const installer = new ProfileInstaller({ profilesDir: path.join(tmpDir(), 'perfis'), playerVersion: '1.0.0', runner: runner as never });
    const result = await installer.install('danillotparreira/fita1');
    assert.equal(result.name, 'fita1');
    assert.deepEqual(cloned, ['https://github.com/danillotparreira/perfil-fita1.git', 'https://github.com/danillotparreira/fita1.git']);
    assert.equal(installer.readRegistry().fita1?.commit, 'abc123');
  });

  it('atualizar um clone Git faz pull e volta à versão anterior se a nova for inválida', async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim();
    const origin = tmpDir();
    writeFiles(origin, { 'perfil.yaml': MANIFEST });
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'v1');
    const profilesDir = tmpDir();
    git(profilesDir, 'clone', '-q', origin, 'promo');
    const installer = new ProfileInstaller({ profilesDir, playerVersion: '1.0.0' });

    fs.writeFileSync(path.join(origin, 'perfil.yaml'), MANIFEST.replace('versao: 0.2.0', 'versao: 0.3.0'));
    git(origin, 'commit', '-q', '-am', 'v2');
    assert.equal((await installer.update('promo')).manifest.versao, '0.3.0');

    const good = git(path.join(profilesDir, 'promo'), 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(origin, 'instalar.sh'), 'echo');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'v3 com código');
    await assert.rejects(installer.update('promo'), /Perfil recusado.*versão anterior .* foi mantida/s);
    assert.equal(git(path.join(profilesDir, 'promo'), 'rev-parse', 'HEAD'), good);
    assert.ok(!fs.existsSync(path.join(profilesDir, 'promo', 'instalar.sh')));
  });

  it('recusa perfis com código ou links e lista os arquivos', () => {
    const dir = tmpDir();
    writeFiles(dir, { 'perfil.yaml': MANIFEST, 'install.sh': 'echo', 'skills/x/helper.ts': '', 'package.json': '{}', '.git/hooks/post-checkout': 'x' });
    assert.deepEqual(findForbiddenFiles(dir).sort(), ['install.sh', 'package.json', 'skills/x/helper.ts']);
  });

  it('instala de pasta local: copia sem .env/dados, cria .env do exemplo, registra e lista pendências', async () => {
    const src = tmpDir();
    writeFiles(src, {
      'perfil.yaml': MANIFEST,
      'skills/curadoria/SKILL.md': '---\nname: curadoria\ndescription: c\n---\nx',
      '.env.example': 'AFILIADO_ID=\n',
      '.env': 'SEGREDO=nao-copiar',
      'dados/agente.db': 'x',
    });
    const profilesDir = path.join(tmpDir(), 'perfis');
    const installer = new ProfileInstaller({ profilesDir, playerVersion: '1.0.0' });
    const result = await installer.install(src);
    assert.equal(result.name, 'promo');
    assert.deepEqual(result.pendingVariables, ['AFILIADO_ID']);
    assert.equal(fs.readFileSync(path.join(result.dir, '.env'), 'utf8'), 'AFILIADO_ID=\n');
    assert.ok(!fs.existsSync(path.join(result.dir, 'dados')));
    assert.equal(installer.readRegistry().promo?.tipo, 'pasta');
    assert.deepEqual(listProfiles([profilesDir]).map((p) => p.name), ['promo']);
    await assert.rejects(installer.install(src), /Já existe um perfil "promo"/);
    const copy = await installer.install(src, { name: 'promo-teste' });
    assert.equal(copy.name, 'promo-teste');

    // Atualizar preserva o .env preenchido.
    fs.writeFileSync(path.join(result.dir, '.env'), 'AFILIADO_ID=meu\n');
    fs.writeFileSync(path.join(src, 'perfil.yaml'), MANIFEST.replace('versao: 0.2.0', 'versao: 0.3.0'));
    const updated = await installer.update('promo');
    assert.equal(updated.manifest.versao, '0.3.0');
    assert.deepEqual(updated.pendingVariables, []);

    installer.remove('promo-teste');
    assert.deepEqual(Object.keys(installer.readRegistry()), ['promo']);
  });

  it('recusa instalação de perfil com código e de perfil que exige tocador mais novo', async () => {
    const installer = new ProfileInstaller({ profilesDir: path.join(tmpDir(), 'perfis'), playerVersion: '1.0.0' });
    const withCode = tmpDir();
    writeFiles(withCode, { 'perfil.yaml': MANIFEST, 'install.sh': 'curl x | sh' });
    await assert.rejects(installer.install(withCode), /Perfil recusado.*\n {2}install\.sh/s);
    const newer = tmpDir();
    writeFiles(newer, { 'perfil.yaml': MANIFEST.replace('>=1.0', '>=1.2') });
    await assert.rejects(installer.install(newer), /requer o tocador >=1.2/);
  });

  it('npm: extrai o .tgz sem tar do sistema e barra caminhos fora do destino e links', () => {
    const dest = tmpDir();
    const tgz = path.join(tmpDir(), 'p.tgz');
    fs.writeFileSync(tgz, makeTgz([{ name: 'package/perfil.yaml', body: 'nome: x\n' }, { name: 'package/skills/a/SKILL.md', body: 'oi' }]));
    assert.deepEqual(extractTarball(tgz, dest, { stripPrefix: 'package/' }).sort(), ['perfil.yaml', path.join('skills', 'a', 'SKILL.md')]);
    fs.writeFileSync(tgz, makeTgz([{ name: 'package/../../fora.txt', body: 'x' }]));
    assert.throws(() => extractTarball(tgz, tmpDir(), { stripPrefix: 'package/' }), /fora do destino/);
    fs.writeFileSync(tgz, makeTgz([{ name: 'package/link', body: '', type: '2' }]));
    assert.throws(() => extractTarball(tgz, tmpDir(), { stripPrefix: 'package/' }), /contém link/);
  });

  it('"novo" gera um perfil válido e carregável', () => {
    const root = setupPlayer();
    const dir = createProfile(path.join(root, 'perfis'), 'historias', '1.0.0');
    const profile = loadProfile('historias', [path.join(root, 'perfis')], '1.0.0');
    assert.equal(profile.dir, dir);
    assert.deepEqual(profile.manifest.canais, ['terminal']);
    assert.throws(() => createProfile(path.join(root, 'perfis'), 'historias', '1.0.0'), /Já existe/);
  });
});

/** Monta um .tgz mínimo (ustar) para testar a extração. */
function makeTgz(entries: Array<{ name: string; body: string; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000644\0', 100);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(entry.type ?? '0', 156);
    header.write('ustar\0', 257);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}
