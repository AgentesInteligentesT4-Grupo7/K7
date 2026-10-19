import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentLoop } from '../src/agent/AgentLoop.js';
import { RefinementLoop } from '../src/agent/RefinementLoop.js';
import { SystemPromptBuilder } from '../src/agent/SystemPromptBuilder.js';
import { RefinementLoopConfigParser, SkillConfigError, type RefinementLoopConfig } from '../src/skills/RefinementLoopConfig.js';
import { SkillExecutor } from '../src/skills/SkillExecutor.js';
import { SkillLoader } from '../src/skills/SkillLoader.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

const BODY = '<idealizador>Você cria ideias.</idealizador>\n<analisador>Você critica ideias.</analisador>';
const frontmatter = (loop: Record<string, unknown>) => ({ name: 'x', description: 'y', loop });
const roles = {
  creator: { provider: 'ollama', model: 'qwen2.5:7b-instruct' },
  critic: { provider: 'gemini', model: 'gemini-3.8-flash' },
};

function config(iterations: number, stopPhrase: string | null = 'Estou satisfeito com a ideia'): RefinementLoopConfig {
  return {
    iterations,
    stopPhrase,
    creator: { tag: 'idealizador', provider: 'ollama', profile: 'cria' },
    critic: { tag: 'analisador', provider: 'gemini', profile: 'critica' },
  };
}

describe('RefinementLoopConfigParser', () => {
  it('lê iterações, frase de parada, modelos e perfis das tags', () => {
    const parsed = RefinementLoopConfigParser.parse('x', frontmatter({ iterations: 20, stop_phrase: 'Estou satisfeito com a ideia', ...roles }), BODY, 30);
    assert.equal(parsed.iterations, 20);
    assert.equal(parsed.creator.provider, 'ollama');
    assert.equal(parsed.creator.model, 'qwen2.5:7b-instruct');
    assert.equal(parsed.critic.model, 'gemini-3.8-flash');
    assert.equal(parsed.creator.profile, 'Você cria ideias.');
    assert.equal(parsed.critic.profile, 'Você critica ideias.');
  });

  it('rejeita configurações inválidas com mensagem amigável', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ iterations: 0, ...roles }, BODY],
      [{ iterations: 99, ...roles }, BODY],
      [{ creator: { provider: 'openai' }, critic: roles.critic }, BODY],
      [{ creator: roles.creator }, BODY],
      [{ ...roles }, '<idealizador>só um</idealizador>'],
    ].map(([loop, body]) => [loop as Record<string, unknown>, body as string]);
    for (const [loop, body] of cases) {
      assert.throws(() => RefinementLoopConfigParser.parse('x', frontmatter(loop), body, 30), SkillConfigError);
    }
  });
});

describe('RefinementLoop', () => {
  it('executa exatamente N rodadas e devolve só a última ideia', async () => {
    const creator = new FakeLlmProvider([{ content: 'ideia v0' }, { content: 'ideia v1' }, { content: 'ideia v2' }, { content: 'ideia v3' }], 'ollama');
    const critic = new FakeLlmProvider([{ content: 'crítica 1' }, { content: 'crítica 2' }, { content: 'crítica 3' }], 'gemini');
    const result = await new RefinementLoop().run({ problem: 'falta de água', config: config(3), creator, critic });

    assert.equal(result.idea, 'ideia v3');
    assert.equal(result.rounds, 3);
    assert.equal(result.satisfied, false);
    assert.equal(creator.requests.length, 4);
    assert.equal(critic.requests.length, 3);
    // O crítico analisa a ideia mais recente; o criador recebe a crítica correspondente.
    assert.match(critic.requests[1]!.messages[1]!.content!, /ideia v1/);
    assert.match(creator.requests[2]!.messages[1]!.content!, /ideia v1[\s\S]*crítica 2/);
    assert.equal(creator.requests[0]!.messages[0]!.content, 'cria');
    assert.equal(critic.requests[0]!.messages[0]!.content, 'critica');
  });

  it('para antes quando o analisador está satisfeito', async () => {
    const creator = new FakeLlmProvider([{ content: 'v0' }, { content: 'v1' }], 'ollama');
    const critic = new FakeLlmProvider([{ content: 'melhore X' }, { content: 'Ótimo. ESTOU SATISFEITO com a ideia!' }], 'gemini');
    const result = await new RefinementLoop().run({ problem: 'p', config: config(20), creator, critic });
    assert.deepEqual({ idea: result.idea, rounds: result.rounds, satisfied: result.satisfied }, { idea: 'v1', rounds: 1, satisfied: true });
    assert.equal(critic.requests.length, 2);
  });

  it('não confunde "não estou satisfeito com a ideia" com a frase de parada', () => {
    assert.equal(RefinementLoop.contains('Ainda não estou satisfeito com a ideia.', 'Estou satisfeito com a ideia'), false);
    assert.equal(RefinementLoop.contains('Estou satisfeito com a ideia', 'Estou satisfeito com a ideia'), true);
  });

  it('se um provider cair no meio, entrega a melhor ideia até então', async () => {
    const creator = new FakeLlmProvider([{ content: 'v0' }, { content: 'v1' }], 'ollama');
    const critic = new FakeLlmProvider([{ content: 'c1' }, new Error('503')], 'gemini');
    const result = await new RefinementLoop().run({ problem: 'p', config: config(5), creator, critic });
    assert.equal(result.idea, 'v1');
    assert.equal(result.rounds, 1);
    assert.match(result.interruptedBy!, /503/);
  });
});

describe('SkillExecutor com skill de refinamento', () => {
  it('usa o modelo de cada papel definido no frontmatter, sem passar pelo AgentLoop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refine-'));
    fs.mkdirSync(path.join(dir, 'ia'));
    fs.writeFileSync(
      path.join(dir, 'ia', 'SKILL.md'),
      `---\nname: idealizador-analisador\ndescription: refina ideias\nloop:\n  iterations: 2\n  creator: { provider: ollama, model: modelo-criador }\n  critic: { provider: gemini, model: modelo-critico }\n---\n${BODY}`,
    );
    const loader = new SkillLoader(dir);
    const [skill] = loader.loadAll();
    const created: string[] = [];
    const providers: Record<string, FakeLlmProvider> = {
      'modelo-criador': new FakeLlmProvider([{ content: 'v0' }, { content: 'v1' }, { content: 'v2' }], 'ollama', 'modelo-criador'),
      'modelo-critico': new FakeLlmProvider([{ content: 'c1' }, { content: 'c2' }], 'gemini', 'modelo-critico'),
    };
    const mainLlm = new FakeLlmProvider([]);
    const executor = new SkillExecutor(loader, new SystemPromptBuilder(new ToolRegistry()), new AgentLoop(mainLlm, new ToolRegistry(), 5), {
      roleProviders: {
        createForRole: (name, model) => {
          created.push(`${name}:${model}`);
          return providers[model!]!;
        },
      },
      maxRefinementRounds: 30,
    });

    const result = await executor.execute({
      skill: skill!,
      availableSkills: [skill!],
      history: [],
      input: { userId: 1, chatId: 1, text: 'Ideia para reciclagem no bairro', source: 'text', requiresAudioReply: false },
    });

    assert.deepEqual(created, ['ollama:modelo-criador', 'gemini:modelo-critico']);
    assert.equal(result.text, 'v2');
    assert.equal(result.details!.refinement_rounds, 2);
    assert.equal(mainLlm.requests.length, 0);
    assert.match(providers['modelo-criador']!.requests[0]!.messages[1]!.content!, /reciclagem no bairro/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('RefinementLoop.stripPlaceholderLabel', () => {
  it('remove o rótulo ecoado pelo modelo sem tocar no conteúdo', () => {
    assert.equal(RefinementLoop.stripPlaceholderLabel('{ideia} - Implementar coleta'), 'Implementar coleta');
    assert.equal(RefinementLoop.stripPlaceholderLabel('**{crítica}:** Falta custo'), 'Falta custo');
    assert.equal(RefinementLoop.stripPlaceholderLabel('A {ideia} é boa'), 'A {ideia} é boa');
  });
});

describe('RefinementLoop.isSatisfied', () => {
  const phrase = 'Estou satisfeito com a ideia';
  it('aceita a frase sozinha ou com um comentário curto', () => {
    assert.equal(RefinementLoop.isSatisfied('Estou satisfeito com a ideia.', phrase), true);
    assert.equal(RefinementLoop.isSatisfied('Ótimo trabalho! Estou satisfeito com a ideia.', phrase), true);
  });
  it('rejeita críticas longas com a frase colada no fim', () => {
    const longCritique = `${'Sugiro detalhar custos, metas, parceiros e indicadores de impacto. '.repeat(4)}Estou satisfeito com a ideia.`;
    assert.equal(RefinementLoop.isSatisfied(longCritique, phrase), false);
  });
});
