import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentController } from '../src/agent/AgentController.js';
import type { AgentInput } from '../src/agent/types.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import type { PrivacyLevel } from '../src/llm/orchestration/types.js';
import type { LlmRequest } from '../src/llm/types.js';
import { ConversationSummarizer } from '../src/memory/ConversationSummarizer.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import type { SkillExecutionRequest } from '../src/skills/SkillExecutor.js';

const IMAGE_SKILL = { name: 'gerador-imagens', description: 'imagens', frontmatter: { privacidade: 'local', gatilhos: ['desenh', 'imagem', 'ilustra'] } };
const OTHER_SKILL = { name: 'resumidor', description: 'resume', frontmatter: {} };

function setup(routeTo: typeof IMAGE_SKILL | typeof OTHER_SKILL | null) {
  const memory = new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 });
  const seen: Array<{ step: string; privacy?: PrivacyLevel }> = [];
  const controller = new AgentController({
    memory,
    skillLoader: { loadAll: () => [IMAGE_SKILL, OTHER_SKILL] } as never,
    skillRouter: { routeWithTask: async () => (seen.push({ step: 'roteamento', privacy: TaskContext.current()?.privacy }), { skill: routeTo, task: 'conversa' }) } as never,
    skillExecutor: {
      execute: async (_r: SkillExecutionRequest) => (seen.push({ step: 'execucao', privacy: TaskContext.current()?.privacy }), { text: 'ok', iterations: 1, steps: [], providerName: 'f', skillName: null }),
    } as never,
    output: { send: async () => undefined, sendError: async () => undefined },
    providerName: 'f',
    privacyDefault: 'publico',
  });
  const input = (text: string): AgentInput => ({ userId: 3, chatId: 1, text, source: 'text', requiresAudioReply: false });
  return { controller, memory, seen, input };
}

describe('Pedido de imagem só no modelo local', () => {
  it('gatilho na mensagem: local desde o roteamento (nenhum modelo de fora vê o pedido); fica salvo na mensagem', async () => {
    const { controller, memory, seen, input } = setup(IMAGE_SKILL);
    await controller.process(input('Quero que DESENHE uma mulher bem realista'));
    assert.deepEqual(seen, [
      { step: 'roteamento', privacy: 'local' },
      { step: 'execucao', privacy: 'local' },
    ]);
    const saved = memory.getHistory('3', memory.getOrCreateActiveConversation('3', 'f').id).at(-1)!;
    assert.equal(saved.metadata?.privacy, 'local');
  });

  it('sem gatilho, mas o roteador escolheu a skill local: a execução vira local; outra skill segue pública', async () => {
    const local = setup(IMAGE_SKILL);
    await local.controller.process(input('faz aquele gato astronauta de novo'));
    assert.deepEqual(local.seen.map((s) => s.privacy), ['publico', 'local']);

    const other = setup(OTHER_SKILL);
    await other.controller.process(other.input('resuma o texto acima'));
    assert.deepEqual(other.seen.map((s) => s.privacy), ['publico', 'publico']);
  });

  it('o resumo da conversa usa o nível mais restrito das mensagens que resume', async () => {
    const memory = new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 });
    const conversation = memory.getOrCreateActiveConversation('9', 'f');
    for (let i = 0; i < 6; i++) {
      memory.saveMessage(conversation.id, 'user', `pedido ${i}`, {});
      memory.saveMessage(conversation.id, 'assistant', `resposta ${i}`, { privacy: i === 2 ? 'local' : 'publico' });
    }
    const privacies: Array<PrivacyLevel | undefined> = [];
    const llm = {
      name: 'f',
      model: 'f',
      chat: async (_r: LlmRequest) => (privacies.push(TaskContext.current()?.privacy), { content: '## Resumo\nconversa de teste', toolCalls: [], providerName: 'f', model: 'f' }),
      healthCheck: async () => undefined,
    };
    const summarizer = new ConversationSummarizer(memory, llm, { recentMessages: 2, trigger: 4, maxChars: 2_000, factsEnabled: false, privacy: 'publico' });
    await summarizer.summarize(conversation.id, '9');
    assert.deepEqual(privacies, ['local']);
  });
});

const input = (text: string): AgentInput => ({ userId: 3, chatId: 1, text, source: 'text', requiresAudioReply: false });
