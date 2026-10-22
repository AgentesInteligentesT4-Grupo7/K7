import type { CatalogEntry, MarkdownCatalog } from './MarkdownCatalog.js';

export interface Persona {
  name: string;
  description: string;
  /** Definição em segunda pessoa ("Você é Kael..."). */
  body: string;
  /** Estilo padrão quando a persona fala. */
  style?: string;
  /** Só estas skills ficam disponíveis com a persona ativa (vazio = todas). */
  skills: string[];
}

/** Personas da fita (`personas/<nome>.md`): cada uma é um agente com memória própria. */
export class PersonaCatalog {
  constructor(private readonly catalog: MarkdownCatalog) {}

  list(): Persona[] {
    return this.catalog.list().map(PersonaCatalog.toPersona);
  }

  get(name: string): Persona | undefined {
    const entry = this.catalog.get(name);
    return entry ? PersonaCatalog.toPersona(entry) : undefined;
  }

  /** Mensagem que começa com "@nome": persona só para esta mensagem (o resto é o texto). */
  mention(text: string): { persona: Persona; text: string } | undefined {
    const match = /^@([a-z0-9][a-z0-9-]*)[\s,:]+([\s\S]+)$/i.exec(text.trim());
    const persona = match ? this.get(match[1]!) : undefined;
    return persona ? { persona, text: match![2]!.trim() } : undefined;
  }

  /** Memória isolada: conversas, resumo e fatos da persona ficam sob outro "usuário" no banco. */
  static memoryUserId(userId: string, persona: Persona | undefined): string {
    return persona ? `${userId}#persona:${persona.name}` : userId;
  }

  private static toPersona(entry: CatalogEntry): Persona {
    const skills = entry.frontmatter.skills;
    return {
      name: entry.name,
      description: entry.description,
      body: entry.body,
      ...(typeof entry.frontmatter.estilo === 'string' ? { style: entry.frontmatter.estilo.trim().toLowerCase() } : {}),
      skills: Array.isArray(skills) ? skills.map((s) => String(s).trim()).filter(Boolean) : [],
    };
  }
}
