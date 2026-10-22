import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentController } from '../src/agent/AgentController.js';
import { ReasoningStrategies, extractMode, parseMode } from '../src/agent/Reasoning.js';
import type { AgentInput } from '../src/agent/types.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { UserSettings } from '../src/memory/UserSettings.js';
import { parseManifest } from '../src/profiles/ProfileManifest.js';
import type { SkillExecutionRequest } from '../src/skills/SkillExecutor.js';
import { FakeLlmProvider } from './helpers/FakeLlmProvider.js';

describe('Modos de raciocínio', () => {
  it('lê o modo por nome ou apelido; "modo=x" sai do texto só quando o modo existe', () => {
    assert.equal(parseMode('CoVe'), 'verificado');
    assert.equal(parseMode('RaR'), 'reformular');
    assert.equal(parseMode('padrão'), 'normal');
    assert.equal(parseMode('turbo'), undefined);
    assert.deepEqual(extractMode('Quando caiu o muro de Berlim? modo=verificado'), { mode: 'verificado', rest: 'Quando caiu o muro de Berlim?' });
    assert.deepEqual(extractMode('o modo=turbo existe?'), { rest: 'o modo=turbo existe?' });
    assert.equal(parseManifest('nome: x\nmodo_padrao: verificar\n').modoPadrao, 'verificado');
    assert.throws(() => parseManifest('nome: x\nmodo_padrao: turbo\n'), /modo_padrao" deve ser normal, reformular, verificado/);
  });

  it('CoVe: planeja perguntas, responde SEM ver o rascunho e revisa com as respostas', async () => {
    const llm = new FakeLlmProvider([
      { content: '{"perguntas": ["Em que ano caiu o Muro de Berlim?", "Qual cidade o muro dividia?"]}' },
      { content: '1. 1989\n2. Berlim' },
      { content: 'O Muro de Berlim caiu em 1989.' },
    ]);
    const result = await new ReasoningStrategies(llm).verify('Quando caiu o Muro?', 'O Muro de Berlim caiu em 1991.');
    assert.deepEqual(result, { text: 'O Muro de Berlim caiu em 1989.', questions: ['Em que ano caiu o Muro de Berlim?', 'Qual cidade o muro dividia?'], changed: true });
    const independent = llm.requests[1]!.messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(independent, /1991/, 'as verificações não veem o rascunho');
    assert.match(llm.requests[2]!.messages[1]!.content!, /Rascunho:\nO Muro de Berlim caiu em 1991\.[\s\S]*Respostas independentes:\n1\. 1989/);
  });

  it('CoVe sem nada factual a verificar devolve o rascunho com um só pedido; RaR devolve a pergunta expandida', async () => {
    const llm = new FakeLlmProvider([{ content: '{"perguntas": []}' }, { content: 'Quais são as melhores formas de aprender violão sozinho, em casa, para um adulto iniciante?' }]);
    const strategies = new ReasoningStrategies(llm);
    assert.deepEqual(await strategies.verify('oi', 'Olá! Tudo bem?'), { text: 'Olá! Tudo bem?', questions: [], changed: false });
    assert.match((await strategies.rephrase('como aprender violão'))!, /adulto iniciante/);
    assert.equal(llm.requests.length, 2);
  });

  it('controller: /modo fixa; modo=... na mensagem vence; RaR não altera o que é salvo; CoVe revisa a resposta', async () => {
    const db = DatabaseConnection.open(':memory:');
    const memory = new MemoryManager(db, { windowSize: 20, maxMessageChars: 10_000 });
    const requests: SkillExecutionRequest[] = [];
    const llm = new FakeLlmProvider([
      { content: 'Pergunta expandida sobre o muro.' },
      { content: '{"perguntas": ["Ano da queda do muro?"]}' },
      { content: '1. 1989' },
      { content: 'Caiu em 1989.' },
    ]);
    const controller = new AgentController({
      memory,
      skillLoader: { loadAll: () => [] } as never,
      skillRouter: { routeWithTask: async () => ({ skill: null, task: 'conversa' }) } as never,
      skillExecutor: {
        execute: async (r: SkillExecutionRequest) => (requests.push(structuredClone(r)), { text: 'Caiu em 1991.', iterations: 1, steps: [], providerName: 'f', skillName: null }),
      } as never,
      output: { send: async () => undefined, sendError: async () => undefined },
      providerName: 'f',
      settings: new UserSettings(db),
      reasoning: new ReasoningStrategies(llm),
    });
    const input = (text: string): AgentInput => ({ userId: 5, chatId: 1, text, source: 'text', requiresAudioReply: false });

    assert.match(controller.modeCommand(5, 'reformular'), /Modo: reformular/);
    assert.match(controller.modeCommand(5, ''), /ativo: reformular/);
    const rar = await controller.process(input('e o muro?'));
    assert.equal(rar.text, 'Caiu em 1991.');
    assert.match(requests[0]!.history.at(-1)!.content!, /^e o muro\?\n\n\[Pergunta reformulada e detalhada, para guiar a resposta: Pergunta expandida sobre o muro\.\]$/);
    const conversation = memory.getOrCreateActiveConversation('5', 'f').id;
    assert.equal(memory.getHistory('5', conversation).find((m) => m.role === 'user')!.content, 'e o muro?', 'o histórico guarda a original');

    const cove = await controller.process(input('quando caiu o muro? modo=verificado'));
    assert.equal(cove.text, 'Caiu em 1989.');
    assert.equal(requests[1]!.input.text, 'quando caiu o muro?');
    assert.equal(llm.requests.length, 4, 'a mensagem com modo=verificado não reformulou');
    const saved = memory.getHistory('5', conversation).at(-1)!;
    assert.equal(saved.content, 'Caiu em 1989.');
    assert.deepEqual([saved.metadata?.mode, (saved.metadata?.verification as { changed: boolean }).changed], ['verificado', true]);

    assert.match(controller.modeCommand(5, 'normal'), /Modo: normal/);
    assert.match(controller.modeCommand(5, 'turbo'), /não existe/);
  });
});
