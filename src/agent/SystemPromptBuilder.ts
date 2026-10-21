import { type AgentIdentity, DEFAULT_IDENTITY } from '../config/AgentIdentity.js';
import type { SkillMetadata } from '../skills/SkillLoader.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { AgentInput } from './types.js';

export interface PromptContext {
  availableSkills: SkillMetadata[];
  activeSkill: { name: string; content: string } | null;
  input: Pick<AgentInput, 'source' | 'requiresAudioReply' | 'attachmentName' | 'channel'>;
}

/** Monta o System Prompt de cada execução do AgentLoop. */
export class SystemPromptBuilder {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly identity: AgentIdentity = DEFAULT_IDENTITY,
  ) {}

  build(context: PromptContext): string {
    const sections = [
      this.identitySection(context.input.channel ?? 'telegram'),
      this.reasoningRules(),
      this.toolsSection(),
      this.fileOutputRules(),
      this.skillsSection(context.availableSkills, context.activeSkill?.name ?? null),
      context.activeSkill ? this.activeSkillSection(context.activeSkill) : '',
      this.inputSection(context.input),
    ];
    return sections.filter(Boolean).join('\n\n');
  }

  private identitySection(channel: string): string {
    const { name, owner, purpose, language, instructions } = this.identity;
    const where = channel === 'terminal' ? 'pelo chat no terminal do computador dele' : 'pelo Telegram';
    const now = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short' }).format(new Date());
    return `# Identidade
Você é o ${name}, ${purpose} de ${owner}. Você roda localmente no computador dele e, nesta conversa, fala com ele ${where} (também atende pelo Telegram e pelo terminal).
Responda sempre em ${language} (a menos que o usuário peça outro idioma), de forma direta, útil e organizada.
Data/hora local atual: ${now}.${instructions ? `

# Foco e instruções do projeto
${instructions}` : ''}

# Formatação
As mensagens são exibidas como texto puro (sem renderização de Markdown). Prefira parágrafos curtos, listas simples com "-" ou números e evite tabelas largas.`;
  }

  private reasoningRules(): string {
    return `# Raciocínio (ReAct)
- Pense passo a passo antes de agir. Quando precisar de informação ou de uma ação no ambiente, chame uma ferramenta.
- Antes de chamar uma ferramenta, escreva em uma frase curta o que pretende fazer e por quê.
- Nunca afirme que executou algo sem ter recebido a observação da ferramenta. Não anuncie ações futuras: execute-as.
- Se uma ferramenta retornar erro, analise a mensagem e tente corrigir (ex.: outro caminho ou argumentos válidos).
- Quando tiver o necessário, entregue a resposta final ao usuário sem chamar mais ferramentas.`;
  }

  private toolsSection(): string {
    const tools = this.registry.list();
    if (tools.length === 0) return '# Ferramentas\nNenhuma ferramenta disponível nesta sessão.';
    const lines = tools.map((tool) => `- ${tool.name}: ${tool.description}`);
    return `# Ferramentas disponíveis\n${lines.join('\n')}\nArquivos criados com as ferramentas ficam no workspace local (caminhos sempre relativos).`;
  }

  private fileOutputRules(): string {
    return `# Entrega de documentos
Quando gerar um documento longo para o usuário baixar (PRD, spec, relatório, resumo extenso, código completo), envolva o conteúdo integral numa tag:
<arquivo nome="nome-do-arquivo.md">
...conteúdo completo em Markdown...
</arquivo>
O sistema entregará esse conteúdo como arquivo .md. Fora da tag, escreva apenas uma mensagem curta de acompanhamento.`;
  }

  private skillsSection(skills: SkillMetadata[], activeName: string | null): string {
    if (skills.length === 0) return '# Skills\nNenhuma skill instalada no momento.';
    const lines = skills.map((skill) => `- ${skill.name}${skill.name === activeName ? ' (ATIVA)' : ''}: ${skill.description}`);
    return `# Skills instaladas (availableSkills)\n${lines.join('\n')}`;
  }

  private activeSkillSection(skill: { name: string; content: string }): string {
    return `# Skill ativa: ${skill.name}
Siga rigorosamente as instruções abaixo para atender esta requisição:

${skill.content}`;
  }

  private inputSection(input: PromptContext['input']): string {
    const notes: string[] = [];
    if (input.source === 'voice') {
      notes.push('A mensagem atual do usuário foi transcrita de um áudio (pode conter pequenos erros de transcrição).');
    }
    if (input.source === 'document' && input.attachmentName) {
      notes.push(`A mensagem atual inclui o conteúdo extraído do documento "${input.attachmentName}".`);
    }
    if (input.requiresAudioReply) {
      notes.push(
        'requires_audio_reply=true: sua resposta será convertida em voz. Seja conversacional e conciso, sem Markdown, listas longas, emojis, URLs ou código. Não use a tag <arquivo> a menos que o usuário peça explicitamente um documento.',
      );
    }
    return notes.length ? `# Contexto da entrada\n${notes.map((note) => `- ${note}`).join('\n')}` : '';
  }
}
