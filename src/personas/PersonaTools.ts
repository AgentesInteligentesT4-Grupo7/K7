import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { ChatMessage, ILlmProvider, JsonSchema } from '../llm/types.js';
import type { ConversationSummarizer } from '../memory/ConversationSummarizer.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../tools/BaseTool.js';
import { type Persona, PersonaCatalog } from './Personas.js';
import type { StyleCatalog } from './Styles.js';

export interface PersonaAgentsDeps {
  personas: PersonaCatalog;
  styles?: StyleCatalog;
  memory: MemoryManager;
  llm: ILlmProvider;
  summarizer?: ConversationSummarizer;
}

/**
 * Personas como agentes (spec personas-styles G-03): cada uma responde em personagem, com a própria
 * memória (conversa, resumo e fatos sob "<usuário>#persona:<nome>"), e guarda o que viveu.
 */
export class PersonaAgents {
  constructor(private readonly deps: PersonaAgentsDeps) {}

  persona(name: unknown): Persona {
    const persona = this.deps.personas.get(String(name ?? ''));
    if (!persona) {
      const available = this.deps.personas.list().map((p) => p.name);
      throw new ToolArgumentError(`Persona "${String(name)}" não existe. Disponíveis: ${available.join(', ') || '(nenhuma)'}`);
    }
    return persona;
  }

  /** Uma fala da persona: grava a entrada e a resposta na memória dela. */
  async reply(userId: string, persona: Persona, incoming: string, temperature = 0.8): Promise<string> {
    const { memory } = this.deps;
    const memoryUser = PersonaCatalog.memoryUserId(userId, persona);
    const conversation = memory.getOrCreateActiveConversation(memoryUser, 'personas');
    memory.saveMessage(conversation.id, 'user', incoming, { from: 'agente' });
    const context = memory.buildContext(conversation.id, memoryUser);
    const messages: ChatMessage[] = [{ role: 'system', content: this.systemPrompt(persona, context.memory) }, ...context.history];
    const privacy = TaskContext.current()?.privacy ?? 'publico';
    // Contexto próprio: a fala da persona não troca o modelo fixado da conversa principal.
    const response = await TaskContext.run({ task: 'conversa', privacy, userId }, () => this.deps.llm.chat({ messages, temperature }));
    const answer = (response.content ?? '').trim() || '(silêncio)';
    memory.saveMessage(conversation.id, 'assistant', answer, { persona: persona.name, provider: response.providerName });
    this.deps.summarizer?.schedule(conversation.id, memoryUser);
    return answer;
  }

  /** Registra uma cena na memória da persona sem pedir resposta (ela "lembra" do diálogo). */
  remember(userId: string, persona: Persona, note: string): void {
    const memoryUser = PersonaCatalog.memoryUserId(userId, persona);
    const conversation = this.deps.memory.getOrCreateActiveConversation(memoryUser, 'personas');
    this.deps.memory.saveMessage(conversation.id, 'user', note, { from: 'cena' });
  }

  private systemPrompt(persona: Persona, memory: string): string {
    const style = persona.style ? this.deps.styles?.get(persona.style) : undefined;
    return [
      `# Você é ${persona.name}`,
      persona.body,
      'Responda sempre como esta personagem, em primeira pessoa e em português do Brasil, sem sair do personagem e sem narrar as outras personagens.',
      'Mesmo em personagem: nada de conteúdo sexual, violência gráfica ou instruções perigosas.',
      memory,
      style ? `# Estilo de escrita: ${style.name}\n${style.body}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

function currentUser(): string {
  const userId = TaskContext.current()?.userId;
  if (!userId) throw new Error('Ferramenta de personas fora de uma conversa');
  return userId;
}

export class TalkToPersonaTool extends BaseTool {
  readonly name = 'falar_com_persona';
  readonly description =
    'Conversa com uma persona da fita (um agente com personalidade e memória próprias) e devolve a resposta dela, em personagem. ' +
    'Use para consultar um personagem ("como o Kael reagiria?"), entrevistar ou pedir a opinião de um especialista definido como persona.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      persona: { type: 'string', description: 'Nome da persona (veja /persona)' },
      mensagem: { type: 'string', description: 'O que dizer ou perguntar a ela' },
    },
    required: ['persona', 'mensagem'],
    additionalProperties: false,
  };

  constructor(private readonly agents: PersonaAgents) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const persona = this.agents.persona(args.persona);
    const answer = await this.agents.reply(currentUser(), persona, String(args.mensagem));
    return { output: `${persona.name}: ${answer}` };
  }
}

export class PersonaDialogueTool extends BaseTool {
  readonly name = 'dialogo_entre_personas';
  readonly description =
    'Encena um diálogo entre duas ou mais personas da fita, em turnos alternados, a partir de uma situação. Cada uma fala com ' +
    'a própria personalidade e memória, e todas guardam a cena. Devolve a transcrição para você usar (roteiro, cena, debate).';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      personas: { type: 'string', description: 'Nomes separados por vírgula, na ordem das falas (ex.: "kael, mira")' },
      situacao: { type: 'string', description: 'Cena ou tema: onde estão, o que aconteceu, o que está em jogo' },
      turnos: { type: 'integer', description: 'Quantas falas no total (2 a 8, padrão 4)' },
    },
    required: ['personas', 'situacao'],
    additionalProperties: false,
  };

  constructor(private readonly agents: PersonaAgents) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const userId = currentUser();
    const cast = String(args.personas)
      .split(/[,;]/)
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => this.agents.persona(n));
    if (cast.length < 2) throw new ToolArgumentError('Informe pelo menos duas personas');
    const turns = Math.min(8, Math.max(2, Number(args.turnos) || 4));
    const scene = String(args.situacao).trim();
    const lines: string[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const speaker = cast[turn % cast.length]!;
      const others = cast.filter((p) => p !== speaker).map((p) => p.name).join(', ');
      const prompt = `[Cena com ${others}] ${scene}\n\nDiálogo até agora:\n${lines.join('\n') || '(início da cena)'}\n\nSua vez. Responda só com a sua fala (1 a 3 frases), sem o seu nome no início.`;
      const answer = await this.agents.reply(userId, speaker, prompt);
      lines.push(`${speaker.name}: ${answer.replace(new RegExp(`^${speaker.name}\\s*:\\s*`, 'i'), '')}`);
    }
    const transcript = lines.join('\n');
    for (const persona of cast) this.agents.remember(userId, persona, `[Cena registrada] ${scene}\n${transcript}`);
    return { output: `Diálogo (${turns} falas):\n${transcript}` };
  }
}
