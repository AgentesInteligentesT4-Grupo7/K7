import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentController } from '../src/agent/AgentController.js';
import { SystemPromptBuilder } from '../src/agent/SystemPromptBuilder.js';
import type { AgentInput } from '../src/agent/types.js';
import { identityFromEnv } from '../src/config/AgentIdentity.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import type { ILlmProvider, LlmRequest } from '../src/llm/types.js';
import { DatabaseConnection } from '../src/memory/DatabaseConnection.js';
import { MemoryManager } from '../src/memory/MemoryManager.js';
import { UserSettings } from '../src/memory/UserSettings.js';
import { MarkdownCatalog } from '../src/personas/MarkdownCatalog.js';
import { PersonaCatalog } from '../src/personas/Personas.js';
import { PersonaAgents, PersonaDialogueTool, TalkToPersonaTool } from '../src/personas/PersonaTools.js';
import { StyleCatalog } from '../src/personas/Styles.js';
import type { SkillExecutionRequest } from '../src/skills/SkillExecutor.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';

const ROOT = path.resolve('estilos');

function writeFiles(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-'));
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

const PERSONAS = {
  'kael.md': '---\nname: kael\ndescription: Mecânico de 19 anos\nestilo: informal\nskills: [roteirista]\n---\nVocê é Kael, mecânico teimoso de {{OWNER_NAME}}.',
  'mira.md': '---\nname: mira\ndescription: Hacker sarcástica\n---\nVocê é Mira, hacker sarcástica.',
};

function fakeLlm(answers: (r: LlmRequest) => string) {
  const requests: LlmRequest[] = [];
  const llm = {
    name: 'falso',
    model: 'x',
    chat: async (r: LlmRequest) => (requests.push(r), { content: answers(r), toolCalls: [], providerName: 'falso', model: 'x' }),
    healthCheck: async () => undefined,
  } as ILlmProvider;
  return { llm, requests };
}

function setup() {
  const db = DatabaseConnection.open(':memory:');
  const memory = new MemoryManager(db, { windowSize: 20, maxMessageChars: 10_000, layered: { compactThreshold: 2_000, tokenBudget: 6_000, factsEnabled: true } });
  const identity = identityFromEnv({ OWNER_NAME: 'Parreira' });
  const personas = new PersonaCatalog(new MarkdownCatalog([writeFiles(PERSONAS)], 'Personas', identity));
  const styles = new StyleCatalog(new MarkdownCatalog([ROOT], 'Estilos', identity));
  const settings = new UserSettings(db);
  const requests: SkillExecutionRequest[] = [];
  const controller = new AgentController({
    memory,
    skillLoader: { loadAll: () => [{ name: 'roteirista' }, { name: 'resumidor' }] } as never,
    skillRouter: { routeWithTask: async () => ({ skill: null, task: 'conversa' }) } as never,
    skillExecutor: {
      execute: async (r: SkillExecutionRequest) => (requests.push(r), { text: 'ok', iterations: 1, steps: [], providerName: 'f', skillName: null }),
    } as never,
    output: { send: async () => undefined, sendError: async () => undefined },
    providerName: 'f',
    personas,
    styles,
    settings,
  });
  return { memory, personas, styles, settings, controller, requests };
}

const input = (text: string): AgentInput => ({ userId: 7, chatId: 1, text, source: 'text', requiresAudioReply: false });

describe('Estilos de texto', () => {
  it('o tocador traz os 10 estilos prontos', () => {
    const { styles } = setup();
    assert.deepEqual(styles.list().map((s) => s.name), ['academico', 'conciso', 'didatico', 'formal', 'infantil', 'informal', 'jornalistico', 'persuasivo', 'poetico', 'tecnico']);
  });

  it('detecta o estilo pedido na mensagem só com palavra de tom; vale o primeiro citado; acentos não importam', () => {
    const { styles } = setup();
    assert.equal(styles.detect('Escreva um e-mail em tom formal para o cliente')?.name, 'formal');
    assert.equal(styles.detect('reescreva de forma infantil e depois técnica')?.name, 'infantil');
    assert.equal(styles.detect('Explique em linguagem técnica')?.name, 'tecnico');
    assert.equal(styles.detect('Isso é formal?'), undefined, 'sem palavra de tom não troca o estilo');
    assert.equal(styles.detect('Qual o horário do jogo?'), undefined);
  });

  it('a fita sobrescreve um estilo do tocador pelo nome', () => {
    const fita = writeFiles({ 'formal.md': '---\nname: formal\ndescription: Formal da fita\n---\nUse "Prezados".' });
    const styles = new StyleCatalog(new MarkdownCatalog([ROOT, fita], 'Estilos'));
    assert.equal(styles.get('formal')?.description, 'Formal da fita');
    assert.equal(styles.list().length, 10);
  });
});

describe('Personas', () => {
  it('lê do Markdown com identidade preenchida; "@nome" vale só para a mensagem; memória isolada por persona', () => {
    const { personas } = setup();
    const kael = personas.get('Kael')!;
    assert.equal(kael.body, 'Você é Kael, mecânico teimoso de Parreira.');
    assert.deepEqual([kael.style, kael.skills], ['informal', ['roteirista']]);
    assert.deepEqual(personas.mention('@kael, como você está?')?.text, 'como você está?');
    assert.equal(personas.mention('@ninguem oi'), undefined);
    assert.equal(PersonaCatalog.memoryUserId('7', kael), '7#persona:kael');
    assert.equal(PersonaCatalog.memoryUserId('7', undefined), '7');
  });

  it('controller: /persona ativa e guarda; memória, skills e estilo seguem a persona; /persona sair volta', async () => {
    const { controller, requests, memory } = setup();
    assert.match(controller.personaCommand(7, ''), /- kael: Mecânico[\s\S]*- mira/);
    assert.match(controller.personaCommand(7, 'kael'), /Agora você fala com kael/);
    await controller.process(input('oi, tudo bem?'));
    const r = requests.at(-1)!;
    assert.equal(r.persona?.name, 'kael');
    assert.equal(r.style?.name, 'informal', 'estilo padrão da persona');
    assert.deepEqual(r.availableSkills.map((s) => s.name), ['roteirista'], 'persona restringe as skills');
    assert.equal(memory.listConversations('7#persona:kael').length, 1);
    assert.equal(memory.listConversations('7').length, 0, 'a conversa do agente fica separada');

    assert.match(controller.personaCommand(7, 'sair'), /De volta ao agente/);
    await controller.process(input('@mira o que acha disso?'));
    assert.equal(requests.at(-1)!.persona?.name, 'mira');
    assert.equal(requests.at(-1)!.input.text, 'o que acha disso?');
    await controller.process(input('e agora?'));
    assert.equal(requests.at(-1)!.persona, undefined, '@menção não fica ativa');
    assert.match(controller.personaCommand(7, 'zé'), /não existe/);
  });

  it('controller: precedência do estilo — pedido na mensagem > persona > /estilo > padrão da fita', async () => {
    const { controller, requests } = setup();
    assert.match(controller.styleCommand(7, 'jornalistico'), /Estilo fixado: jornalistico/);
    await controller.process(input('conte o que houve'));
    assert.equal(requests.at(-1)!.style?.name, 'jornalistico');
    await controller.process(input('conte em tom poético'));
    assert.equal(requests.at(-1)!.style?.name, 'poetico');
    controller.personaCommand(7, 'kael');
    await controller.process(input('conte o que houve'));
    assert.equal(requests.at(-1)!.style?.name, 'informal', 'persona vence o /estilo');
    controller.personaCommand(7, 'sair');
    controller.styleCommand(7, 'padrao');
    await controller.process(input('conte o que houve'));
    assert.equal(requests.at(-1)!.style, undefined);
  });

  it('o system prompt traz a persona e o estilo', () => {
    const prompt = new SystemPromptBuilder(new ToolRegistry()).build({
      availableSkills: [],
      activeSkill: null,
      input: { source: 'text', requiresAudioReply: false },
      persona: { name: 'kael', body: 'Você é Kael.' },
      style: { name: 'formal', body: '- Norma-padrão.' },
    });
    assert.match(prompt, /# Persona ativa: kael\nNesta conversa você fala COMO kael[\s\S]*Você é Kael\./);
    assert.match(prompt, /# Estilo de escrita: formal\n[\s\S]*- Norma-padrão\./);
  });
});

describe('Personas como agentes (multiagente)', () => {
  it('falar_com_persona: responde em personagem e guarda a troca na memória dela', async () => {
    const { memory, personas, styles } = setup();
    const { llm, requests } = fakeLlm(() => 'Eu conserto, mas não prometo nada.');
    const agents = new PersonaAgents({ personas, styles, memory, llm });
    const out = await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: '7', pinned: 'modelo/principal' }, async () => {
      const result = await new TalkToPersonaTool(agents).execute({ persona: 'kael', mensagem: 'Conserta minha moto?' });
      assert.equal(TaskContext.current()!.pinned, 'modelo/principal', 'não troca o modelo da conversa principal');
      return result;
    });
    assert.equal(out.output, 'kael: Eu conserto, mas não prometo nada.');
    assert.match(String(requests[0]!.messages[0]!.content), /^# Você é kael\n\nVocê é Kael[\s\S]*# Estilo de escrita: informal/);
    const conversation = memory.getOrCreateActiveConversation('7#persona:kael', 'x');
    assert.deepEqual(memory.getContextWindow(conversation.id).map((m) => m.content), ['Conserta minha moto?', 'Eu conserto, mas não prometo nada.']);
    await assert.rejects(TaskContext.run({ task: 'conversa', privacy: 'publico', userId: '7' }, () => new TalkToPersonaTool(agents).execute({ persona: 'zé', mensagem: 'oi' })), /Disponíveis: kael, mira/);
  });

  it('dialogo_entre_personas: alterna as falas, cada uma vê o que já foi dito, e todas guardam a cena', async () => {
    const { memory, personas } = setup();
    let turn = 0;
    const { llm, requests } = fakeLlm((r) => {
      turn++;
      const who = String(r.messages[0]!.content).startsWith('# Você é kael') ? 'kael' : 'mira';
      return turn === 1 ? `${who}: Chegamos tarde.` : `Fala ${turn} de ${who}.`;
    });
    const tool = new PersonaDialogueTool(new PersonaAgents({ personas, memory, llm }));
    const { output } = await TaskContext.run({ task: 'conversa', privacy: 'publico', userId: '7' }, () =>
      tool.execute({ personas: 'kael, mira', situacao: 'beco com chuva neon', turnos: 3 }),
    );
    assert.equal(output, 'Diálogo (3 falas):\nkael: Chegamos tarde.\nmira: Fala 2 de mira.\nkael: Fala 3 de kael.');
    assert.match(String(requests[2]!.messages.at(-1)!.content), /kael: Chegamos tarde\.\nmira: Fala 2 de mira\./);
    const miraMemory = memory.getContextWindow(memory.getOrCreateActiveConversation('7#persona:mira', 'x').id).map((m) => m.content ?? '');
    assert.ok(miraMemory.at(-1)!.startsWith('[Cena registrada] beco com chuva neon\nkael: Chegamos tarde.'));
    await assert.rejects(TaskContext.run({ task: 'conversa', privacy: 'publico', userId: '7' }, () => tool.execute({ personas: 'kael', situacao: 'x' })), /pelo menos duas/);
  });
});
