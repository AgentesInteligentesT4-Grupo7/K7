import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SkillLoader } from '../src/skills/SkillLoader.js';
import { SkillRouter } from '../src/skills/SkillRouter.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

let dir: string;

function writeSkill(folder: string, content: string | null): void {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  if (content !== null) fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), content);
}

describe('SkillLoader', () => {
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    writeSkill('a-prd', '---\nname: prd-manager\ndescription: Cria PRDs\n---\n# Instruções PRD\nDetalhes...');
    writeSkill('b-ghost', null); // EC-02: sem SKILL.md
    writeSkill('c-broken', '# Sem frontmatter\nname: x'); // EC-03
    writeSkill('d-noname', '---\ndescription: falta nome\n---\ncorpo');
    writeSkill('e-dup', '---\nname: prd-manager\ndescription: PRD versão nova\n---\ncorpo novo'); // EC-01
    writeSkill('f-git', '---\r\nname: git-manager\r\ndescription: Gerencia repositórios\r\n---\r\ncorpo git');
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('carrega apenas skills válidas e a duplicata posterior substitui a anterior', () => {
    const skills = new SkillLoader(dir).loadAll();
    assert.deepEqual(skills.map((s) => s.name).sort(), ['git-manager', 'prd-manager']);
    assert.equal(skills.find((s) => s.name === 'prd-manager')!.description, 'PRD versão nova');
  });

  it('loadContent devolve o corpo sem o frontmatter', () => {
    const loader = new SkillLoader(dir);
    const git = loader.loadAll().find((s) => s.name === 'git-manager')!;
    assert.equal(loader.loadContent(git), 'corpo git');
  });

  it('hot-reload: nova pasta aparece sem reiniciar', () => {
    const loader = new SkillLoader(dir);
    const before = loader.loadAll().length;
    writeSkill('g-new', '---\nname: nova\ndescription: recém criada\n---\nx');
    assert.equal(loader.loadAll().length, before + 1);
  });

  it('diretório inexistente retorna lista vazia (sem ENOENT)', () => {
    assert.deepEqual(new SkillLoader(path.join(dir, 'nao-existe')).loadAll(), []);
  });
});

describe('SkillRouter', () => {
  const skills = [
    { name: 'prd-manager', description: 'PRDs', directory: '', filePath: '' },
    { name: 'resumidor', description: 'Resumos', directory: '', filePath: '' },
  ];

  it('retorna a skill indicada pelo JSON', async () => {
    const router = new SkillRouter(new FakeLlmProvider([{ content: '{"skillName": "prd-manager"}' }]));
    assert.equal((await router.route('crie uma spec', skills))?.name, 'prd-manager');
  });

  it('aceita JSON dentro de bloco de código', async () => {
    const router = new SkillRouter(new FakeLlmProvider([{ content: '```json\n{"skillName":"resumidor"}\n```' }]));
    assert.equal((await router.route('resuma', skills))?.name, 'resumidor');
  });

  it('null, parse error, skill inexistente e falha do provider caem no agente casual', async () => {
    for (const reply of [{ content: '{"skillName": null}' }, { content: 'acho que prd' }, { content: '{"skillName":"xyz"}' }, new Error('503')]) {
      const router = new SkillRouter(new FakeLlmProvider([reply]));
      assert.equal(await router.route('oi', skills), null);
    }
  });

  it('não chama o LLM quando não há skills', async () => {
    const provider = new FakeLlmProvider([]);
    assert.equal(await new SkillRouter(provider).route('oi', []), null);
    assert.equal(provider.requests.length, 0);
  });
});
