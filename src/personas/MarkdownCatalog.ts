import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { type AgentIdentity, DEFAULT_IDENTITY, renderIdentity } from '../config/AgentIdentity.js';
import { errorMessage } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';

export interface CatalogEntry {
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  /** Corpo do arquivo, com os marcadores {{AGENT_NAME}} etc. preenchidos. */
  body: string;
  file: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Arquivos `<pasta>/<nome>.md` com frontmatter, em camadas (tocador → fita): o da camada posterior vence.
 * Relidos a cada uso (hot-reload, como as skills). Base de personas e estilos (spec personas-styles).
 */
export class MarkdownCatalog {
  private readonly logger: Logger;

  constructor(
    private readonly dirs: string[],
    private readonly kind: string,
    private readonly identity: AgentIdentity = DEFAULT_IDENTITY,
  ) {
    this.logger = new Logger(kind);
  }

  list(): CatalogEntry[] {
    const byName = new Map<string, CatalogEntry>();
    for (const dir of this.dirs) {
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md');
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        const entry = this.parse(path.join(dir, file));
        if (entry) byName.set(entry.name, entry);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): CatalogEntry | undefined {
    const wanted = name.trim().toLowerCase().replace(/^@/, '');
    return this.list().find((e) => e.name === wanted);
  }

  private parse(file: string): CatalogEntry | undefined {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    let frontmatter: Record<string, unknown> = {};
    if (match) {
      try {
        frontmatter = (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
      } catch (error) {
        this.logger.warn(`YAML inválido em ${path.basename(file)}: ${errorMessage(error).split('\n')[0]}`);
        return undefined;
      }
    }
    const name = String(frontmatter.name ?? path.basename(file, '.md')).trim().toLowerCase();
    if (!NAME.test(name)) {
      this.logger.warn(`${path.basename(file)}: "name" deve ter letras minúsculas, números e hífen`);
      return undefined;
    }
    const body = renderIdentity((match ? match[2]! : text).trim(), this.identity);
    return { name, description: String(frontmatter.description ?? '').trim(), frontmatter, body, file };
  }
}
