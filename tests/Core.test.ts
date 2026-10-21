import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentController } from '../src/agent/AgentController.js';
import { AgentLoop } from '../src/agent/AgentLoop.js';
import { SystemPromptBuilder } from '../src/agent/SystemPromptBuilder.js';
import type { AgentResponse } from '../src/agent/types.js';
import { Config, ConfigError } from '../src/config/Config.js';
import { AllProvidersFailedError, LlmProviderError } from '../src/errors/AppErrors.js';
import { FallbackLlmProvider } from '../src/llm/FallbackLlmProvider.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { SkillExecutor } from '../src/skills/SkillExecutor.js';
import { SkillLoader } from '../src/skills/SkillLoader.js';
import { SkillRouter } from '../src/skills/SkillRouter.js';
import { ToolFactory } from '../src/tools/ToolFactory.js';
import { WorkspaceSandbox } from '../src/tools/WorkspaceSandbox.js';
import { FakeLlmProvider, toolCall } from './helpers/FakeLlmProvider.js';

describe('FallbackLlmProvider', () => {
  it('cai para o próximo provider quando o principal falha (503)', async () => {
    const primary = new FakeLlmProvider([new LlmProviderError('gemini', 'HTTP 503', 503)], 'gemini');
    const backup = new FakeLlmProvider([{ content: 'resposta do deepseek' }], 'deepseek');
    const result = await new FallbackLlmProvider([primary, backup]).chat({ messages: [] });
    assert.equal(result.content, 'resposta do deepseek');
    assert.equal(result.providerName, 'deepseek');
  });

  it('lança AllProvidersFailedError amigável quando todos falham', async () => {
    const chain = new FallbackLlmProvider([
      new FakeLlmProvider([new Error('x')], 'gemini'),
      new FakeLlmProvider([new Error('y')], 'deepseek'),
    ]);
    await assert.rejects(chain.chat({ messages: [] }), AllProvidersFailedError);
  });
});

describe('Config', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_ALLOWED_USER_IDS: '1, 2',
    GEMINI_API_KEY: 'k',
  };

  it('aplica defaults (MAX_ITERATIONS=5 quando ausente/inválido)', () => {
    const config = new Config({ ...base, MAX_ITERATIONS: 'abc' }, os.tmpdir());
    assert.equal(config.maxIterations, 5);
    assert.equal(config.llmProvider, 'gemini');
    assert.deepEqual([...config.allowedUserIds], [1, 2]);
  });

  it('troca de provider via LLM_PROVIDER exige a key correspondente', () => {
    assert.throws(() => new Config({ ...base, LLM_PROVIDER: 'deepseek' }), ConfigError);
    const config = new Config({ ...base, LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd', LLM_FALLBACK_PROVIDERS: 'gemini,deepseek' });
    assert.equal(config.llmProvider, 'deepseek');
    assert.deepEqual(config.llmFallbackProviders, ['gemini']);
  });

  it('rejeita whitelist vazia ou inválida', () => {
    assert.throws(() => new Config({ ...base, TELEGRAM_ALLOWED_USER_IDS: '' }), ConfigError);
    assert.throws(() => new Config({ ...base, TELEGRAM_ALLOWED_USER_IDS: 'abc' }), ConfigError);
  });
});

describe('WorkspaceSandbox', () => {
  const sandbox = new WorkspaceSandbox(path.join(os.tmpdir(), 'ws-root'));

  it('bloqueia path traversal e caminhos absolutos', () => {
    assert.throws(() => sandbox.resolve('../segredo.txt'));
    assert.throws(() => sandbox.resolve('notas/../../fora.txt'));
    assert.throws(() => sandbox.resolve('C:\\Windows\\system.ini'));
    assert.throws(() => sandbox.resolve('a;rm -rf.txt'));
  });

  it('aceita caminhos relativos dentro do workspace', () => {
    assert.equal(sandbox.display(sandbox.resolve('notas/ideias.md')), 'notas/ideias.md');
    assert.equal(sandbox.display(sandbox.resolve('/notas/x.md')), 'notas/x.md');
  });
});

describe('Pipeline completa (Controller → Router → Executor → Loop → Memória → Output)', () => {
  it('roteia para a skill, executa ferramenta real, persiste e entrega', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
    const skillsDir = path.join(root, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'prd'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'prd', 'SKILL.md'), '---\nname: prd-manager\ndescription: PRDs\n---\nUSE O TEMPLATE SDD');

    const registry = new ToolFactory(path.join(root, 'ws')).createRegistry();
    const llm = new FakeLlmProvider([
      { content: 'Vou salvar', toolCalls: [toolCall('criar_arquivo', '{"caminho":"specs/auth.md","conteudo":"# Auth"}')] },
      { content: 'Spec criada!\n<arquivo nome="auth.md"># Auth</arquivo>' },
    ]);
    const router = new FakeLlmProvider([{ content: '{"skillName":"prd-manager"}' }]);
    const memory = new MemoryManager(DatabaseConnection.open(':memory:'), { windowSize: 20, maxMessageChars: 10_000 });
    const loader = new SkillLoader(skillsDir);
    const sent: AgentResponse[] = [];

    const controller = new AgentController({
      memory,
      skillLoader: loader,
      skillRouter: new SkillRouter(router),
      skillExecutor: new SkillExecutor(loader, new SystemPromptBuilder(registry), new AgentLoop(llm, registry, 5), {
        roleProviders: { createForRole: () => assert.fail("sem papéis") },
        maxRefinementRounds: 30,
      }),
      output: { send: async (_chat, response) => void sent.push(response), sendError: async () => assert.fail('não deveria falhar') },
      providerName: 'fake',
    });

    await controller.handle({ userId: 7, chatId: 7, text: 'Crie a spec de auth', source: 'text', requiresAudioReply: false });

    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /Spec criada!/);
    assert.equal(fs.readFileSync(path.join(root, 'ws', 'specs', 'auth.md'), 'utf8'), '# Auth');
    assert.match(llm.requests[0]!.messages[0]!.content!, /Skill ativa: prd-manager[\s\S]*USE O TEMPLATE SDD/);

    const conversation = memory.getOrCreateActiveConversation('7', 'fake');
    assert.equal(memory.countMessages(conversation.id), 3); // user + tool + assistant
    assert.deepEqual(memory.getContextWindow(conversation.id).map((m) => m.role), ['user', 'assistant']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
