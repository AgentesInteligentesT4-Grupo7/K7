import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentController } from '../src/agent/AgentController.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import type { SkillExecutionRequest } from '../src/skills/SkillExecutor.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { DebateEngine, DebateStore, DebateTool, debateContext } from '../src/modules/refinamento/Debate.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

const ctx = <T>(fn: () => Promise<T>) => TaskContext.run({ task: 'conversa', privacy: 'publico', userId: '42' }, fn);

describe('Debate entre agentes com o usuário no meio', () => {
  it('inicia, pausa com a tabela, aceita descartar/ideia/combinar, lembra o agente e encerra com síntese', async () => {
    const llm = new FakeLlmProvider([
      // iniciar: perspectivas, 2 posições, juiz
      { content: '{"agentes": [{"nome": "Pragmática", "perspectiva": "custo e prazo"}, {"nome": "Criativa", "perspectiva": "ideias ousadas"}]}' },
      { content: 'Feira de trocas mensal na praça.' },
      { content: 'App de troca com gamificação.' },
      { content: '{"notas": [{"id": 1, "fundamentacao": 8, "viabilidade": 9, "originalidade": 4}, {"id": 2, "fundamentacao": 5, "viabilidade": 4, "originalidade": 9}]}' },
      // continuar: híbrido, 3 posições atualizadas, juiz
      { content: 'Feira mensal com um quadro de trocas online simples.' },
      { content: 'Mantenho a feira, mas aceito divulgar online.' },
      { content: 'Minha ideia: trocas na escola, com os alunos organizando.' },
      { content: 'Híbrido refinado.' },
      { content: '{"notas": [{"id": 1, "fundamentacao": 8, "viabilidade": 8, "originalidade": 5}, {"id": 3, "fundamentacao": 7, "viabilidade": 9, "originalidade": 7}, {"id": 4, "fundamentacao": 9, "viabilidade": 8, "originalidade": 8}]}' },
      // encerrar
      { content: 'Recomendação: feira mensal na escola com quadro online.' },
    ]);
    const store = new DebateStore(DatabaseConnection.open(':memory:'));
    const tool = new DebateTool(new DebateEngine(llm, store));
    const context = debateContext(store);

    const started = (await ctx(() => tool.execute({ acao: 'iniciar', tema: 'Como reduzir o desperdício no bairro?', agentes: 2 }))).output;
    assert.match(started, /Debate: Como reduzir o desperdício no bairro\? \(rodada 1\)/);
    assert.match(started, /\[1\] Pragmática\nFeira de trocas mensal na praça\./);
    assert.match(started, /\| 1 \| Pragmática \| 8 \| 9 \| 4 \| 21 \|\n\| 2 \| Criativa \| 5 \| 4 \| 9 \| 18 \|/);
    assert.match(started, /pergunte o que fazer: manter ou descartar/);
    assert.match((await ctx(() => context.contextFor('descarta o 2')))!, /# Debate em andamento[\s\S]*acao=continuar/);
    assert.equal(await ctx(async () => context.ongoing!()), true, 'debate recente segura o roteador');

    const next = (await ctx(() => tool.execute({ acao: 'continuar', descartar: '2', nova_ideia: 'trocas na escola', combinar: true }))).output;
    assert.match(next, /rodada 2/);
    assert.match(next, /\[3\] Ideia do usuário[\s\S]*\[4\] Híbrido 1\+3/);
    assert.match(next, /Fora do debate: \[2\] Criativa/);
    assert.match(next, /\| 4 \| Híbrido 1\+3 \| 9 \| 8 \| 8 \| 25 \|\n\| 3 \|/, 'tabela ordenada pela nota');
    const reflection = llm.requests[5]!.messages[1]!.content!;
    assert.match(reflection, /Sua posição atual: Feira de trocas mensal na praça\.[\s\S]*Posições dos outros:\n- Ideia do usuário: trocas na escola/);
    assert.doesNotMatch(reflection, /App de troca/, 'o descartado não participa');

    const end = (await ctx(() => tool.execute({ acao: 'encerrar' }))).output;
    assert.match(end, /Conclusão do debate:\n\nRecomendação: feira mensal na escola/);
    assert.match(llm.requests.at(-1)!.messages[1]!.content!, /Híbrido 1\+3 \(nota 25\)/);
    assert.equal(await ctx(() => context.contextFor('oi')), undefined, 'sem debate, sem lembrete');
    assert.equal(await ctx(async () => context.ongoing!()), false);
    await assert.rejects(ctx(() => tool.execute({ acao: 'continuar' })), /Não há debate em andamento/);
  });

  it('perspectivas dadas pelo usuário dispensam o pedido de geração', async () => {
    const llm = new FakeLlmProvider([{ content: 'A' }, { content: 'B' }, { content: '{"notas": []}' }]);
    const tool = new DebateTool(new DebateEngine(llm, new DebateStore(DatabaseConnection.open(':memory:'))));
    const out = (await ctx(() => tool.execute({ acao: 'iniciar', tema: 'x', perspectivas: 'Engenheira: custo; Designer: usuário' }))).output;
    assert.match(out, /\[1\] Engenheira\nA\n\n\[2\] Designer\nB/);
    assert.equal(llm.requests.length, 3);
    assert.match(llm.requests[0]!.messages[0]!.content!, /Você é Engenheira[\s\S]*perspectiva: custo/);
  });

  it('controller: com sessão interativa em andamento, o roteador não troca de skill e o lembrete vai no prompt', async () => {
    let routed = 0;
    const requests: SkillExecutionRequest[] = [];
    const controller = new AgentController({
      memory: new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 }),
      skillLoader: { loadAll: () => [{ name: 'idealizador-analisador' }] } as never,
      skillRouter: { routeWithTask: async () => (routed++, { skill: { name: 'idealizador-analisador' }, task: 'raciocinio' }) } as never,
      skillExecutor: { execute: async (r: SkillExecutionRequest) => (requests.push(r), { text: 'ok', iterations: 1, steps: [], providerName: 'f', skillName: null }) } as never,
      output: { send: async () => undefined, sendError: async () => undefined },
      providerName: 'f',
      contextProviders: [{ contextFor: async () => '# Debate em andamento', ongoing: () => true }],
    });
    await controller.process({ userId: 1, chatId: 1, text: 'descarta o 3 e combina', source: 'text', requiresAudioReply: false });
    assert.equal(routed, 0);
    assert.equal(requests[0]!.skill, null);
    assert.equal(requests[0]!.retrieved, '# Debate em andamento');
  });
});
