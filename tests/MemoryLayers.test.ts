import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlmProvider, LlmRequest } from '../src/llm/types.js';
import { buildHistory, compactMessage, memorySection } from '../src/memory/ContextBuilder.js';
import { ConversationSummarizer } from '../src/memory/ConversationSummarizer.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import type { StoredMessage } from '../src/memory/MessageRepository.js';

const LAYERED = { compactThreshold: 2_000, tokenBudget: 6_000, factsEnabled: true };
const msg = (id: number, role: 'user' | 'assistant', content: string): StoredMessage => ({ id, conversationId: 'c', role, content, metadata: null, createdAt: '' });

function memory() {
  return new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 100_000, layered: LAYERED });
}

const SUMMARY = `## Assunto
- App de finanças pessoais
## Pedidos do usuário
- PRD do app com foco em controle de gastos (#3)
## Decisões e fatos
- Nome do app: Cofrinho (#5)
### FATOS_DURADOUROS
- Prefere respostas curtas
- Projeto Cofrinho usa Postgres`;

function fakeLlm(answer: string) {
  const requests: LlmRequest[] = [];
  const llm = {
    name: 'falso',
    model: 'x',
    chat: async (r: LlmRequest) => (requests.push(r), { content: answer, toolCalls: [], providerName: 'falso', model: 'x' }),
    healthCheck: async () => undefined,
  } as ILlmProvider;
  return { llm, requests };
}

describe('Memória v1.1: compactação e montagem do contexto', () => {
  it('resposta longa vira início + marcador; documento gerado vira referência; o original não muda', () => {
    const long = msg(7, 'assistant', 'A'.repeat(6_931));
    const compact = compactMessage(long, 2_000);
    assert.ok(compact.length < 600);
    assert.match(compact, /\[resposta longa compactada: 6931 caracteres, mensagem #7\]$/);
    assert.equal(long.content.length, 6_931);
    assert.equal(compactMessage(msg(8, 'assistant', 'Segue: <arquivo nome="prd.md"># PRD\n...muito texto...</arquivo>'), 2_000), 'Segue: [documento gerado: prd.md]');
  });

  it('corta as mais antigas para caber no orçamento, mantendo a última pergunta inteira e começando por "user"', () => {
    const messages = [msg(1, 'user', 'a'.repeat(4_000)), msg(2, 'assistant', 'b'.repeat(1_500)), msg(3, 'user', 'c'.repeat(9_000))];
    const history = buildHistory(messages, '', { compactThreshold: 2_000, tokenBudget: 2_000 });
    assert.equal(history.length, 1);
    assert.equal(history[0]!.content!.length, 9_000, 'a pergunta atual nunca é cortada');
    assert.equal(memorySection('', []), '');
    assert.match(memorySection('## Assunto\n- x', ['Prefere respostas curtas']), /# Memória da conversa[\s\S]*# Fatos sobre o usuário\n- Prefere respostas curtas/);
  });

  it('com resumo: o contexto traz só o que não foi resumido, e resumo + fatos vão para o system prompt', () => {
    const m = memory();
    const conversation = m.getOrCreateActiveConversation('u1', 'p');
    for (let i = 1; i <= 6; i++) m.saveMessage(conversation.id, i % 2 ? 'user' : 'assistant', `mensagem ${i}`);
    m.summaries.save(conversation.id, '## Assunto\n- teste', 4);
    m.summaries.replaceFacts('u1', ['Prefere respostas curtas'], 4);
    const built = m.buildContext(conversation.id, 'u1');
    assert.deepEqual(built.history.map((h) => h.content), ['mensagem 5', 'mensagem 6']);
    assert.match(built.memory, /## Assunto\n- teste[\s\S]*Prefere respostas curtas/);
    const plain = new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 1000 });
    assert.equal(plain.buildContext('x', 'u1').memory, '', 'sem camadas: comportamento v1.0');
  });
});

describe('Memória v1.1: resumidor', () => {
  it('só resume quando há mensagens suficientes fora da janela recente; grava resumo e fatos', async () => {
    const m = memory();
    const conversation = m.getOrCreateActiveConversation('u1', 'p');
    const { llm, requests } = fakeLlm(SUMMARY);
    const summarizer = new ConversationSummarizer(m, llm, { recentMessages: 4, trigger: 3, maxChars: 2_000, factsEnabled: true, privacy: 'publico' });
    for (let i = 1; i <= 6; i++) m.saveMessage(conversation.id, i % 2 ? 'user' : 'assistant', `fala ${i}`);
    assert.equal(await summarizer.summarize(conversation.id, 'u1'), false, '2 fora da janela < gatilho 3');
    m.saveMessage(conversation.id, 'user', 'fala 7');
    assert.equal(await summarizer.summarize(conversation.id, 'u1'), true);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.messages[0]!.content!, /#1 usuário: fala 1\n#2 assistente: fala 2\n#3 usuário: fala 3/);
    const latest = m.summaries.latest(conversation.id)!;
    assert.equal(latest.coversUntil, 3);
    assert.ok(!latest.summary.includes('FATOS'));
    assert.deepEqual(m.summaries.facts('u1').map((f) => f.fact), ['Prefere respostas curtas', 'Projeto Cofrinho usa Postgres']);
    assert.deepEqual(m.unsummarized(conversation.id).map((x) => x.content), ['fala 4', 'fala 5', 'fala 6', 'fala 7']);
  });

  it('formato inválido mantém o resumo anterior; segredos nunca entram; fatos contraditos saem', () => {
    assert.equal(ConversationSummarizer.parse('Claro! Aqui vai um resumo livre.', 2_000), undefined);
    const parsed = ConversationSummarizer.parse(
      `## Decisões e fatos\n- Banco: MySQL (#9)\n- API key: AIzaSyA1234567890abcdefghijklmnop\n- senha: hunter2\n### FATOS_DURADOUROS\n- Projeto usa MySQL\n- token=abc123secret`,
      2_000,
    )!;
    assert.equal(parsed.summary, '## Decisões e fatos\n- Banco: MySQL (#9)');
    assert.deepEqual(parsed.facts, ['Projeto usa MySQL']);
    assert.deepEqual(ConversationSummarizer.parse('## Assunto\n- x\n### FATOS_DURADOUROS\n- (nenhum)', 2_000)!.facts, []);
    const tidy = ConversationSummarizer.parse('## Assunto\n- app (#2)\n## Entregas\n- (nenhuma)\n## Pendências\n- schema\n### FATOS_DURADOUROS\n- Prefere respostas curtas (#22)', 2_000)!;
    assert.equal(tidy.summary, '## Assunto\n- app (#2)\n## Pendências\n- schema', 'seção vazia sai');
    assert.deepEqual(tidy.facts, ['Prefere respostas curtas'], 'fato sem a referência #n');
    const huge = ConversationSummarizer.parse(`## Assunto\n${'- linha comprida de resumo\n'.repeat(200)}`, 300)!;
    assert.ok(huge.summary.length <= 305 && huge.summary.endsWith('[…]'));

    const m = memory();
    m.summaries.replaceFacts('u1', ['Projeto usa Postgres', 'Prefere respostas curtas'], 1);
    m.summaries.replaceFacts('u1', ['Projeto usa MySQL', 'Prefere respostas curtas'], 2);
    assert.deepEqual(m.summaries.facts('u1').map((f) => f.fact), ['Prefere respostas curtas', 'Projeto usa MySQL']);
  });

  it('falha do LLM de resumo não quebra nada (fica o anterior)', async () => {
    const m = memory();
    const conversation = m.getOrCreateActiveConversation('u1', 'p');
    for (let i = 1; i <= 20; i++) m.saveMessage(conversation.id, i % 2 ? 'user' : 'assistant', `fala ${i}`);
    const llm = { name: 'x', model: 'x', chat: async () => { throw new Error('fora do ar'); }, healthCheck: async () => undefined } as ILlmProvider;
    const summarizer = new ConversationSummarizer(m, llm, { recentMessages: 8, trigger: 10, maxChars: 2_000, factsEnabled: true, privacy: 'publico' });
    assert.equal(await summarizer.summarize(conversation.id, 'u1'), false);
    assert.equal(m.summaries.latest(conversation.id), undefined);
  });

  it('/esquecer: um fato pelo número, ou tudo (fatos + resumo); /nova não leva o resumo, mas mantém os fatos', () => {
    const m = memory();
    const first = m.getOrCreateActiveConversation('u1', 'p');
    m.summaries.save(first.id, '## Assunto\n- antigo', 2);
    m.summaries.replaceFacts('u1', ['A', 'B'], 1);
    assert.equal(m.summaries.removeFact('u1', 1), 'A');
    const second = m.startNewConversation('u1', 'p');
    assert.equal(m.buildContext(second.id, 'u1').memory, '# Fatos sobre o usuário\n- B');
    m.summaries.clearFacts('u1');
    m.summaries.clear(first.id);
    assert.equal(m.summaries.latest(first.id)!.summary, '');
  });
});
