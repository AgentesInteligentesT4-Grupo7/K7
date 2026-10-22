import fs from 'node:fs';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { type AgentIdentity, DEFAULT_IDENTITY, renderIdentity } from '../config/AgentIdentity.js';
import { errorMessage } from '../errors/AppErrors.js';
import { Logger } from '../utils/Logger.js';

export interface SkillMetadata {
  name: string;
  description: string;
  /** Pasta da skill (ex.: .agents/skills/prd-manager). */
  directory: string;
  /** Caminho do SKILL.md. */
  filePath: string;
  /** Frontmatter completo (ex.: bloco `loop:` das skills de refinamento). */
  frontmatter?: Record<string, unknown>;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/**
 * Lê `<pasta-de-skills>/<skill>/SKILL.md` de forma síncrona a cada requisição,
 * o que garante hot-reload sem reiniciar o processo. Aceita várias pastas em camadas
 * (módulos ligados → perfil): em nomes repetidos, vale a camada mais à direita.
 */
export class SkillLoader {
  private readonly logger = new Logger('SkillLoader');

  private readonly skillsDirs: string[];

  constructor(
    skillsDir: string | string[],
    /** Marcadores {{AGENT_NAME}}, {{OWNER_NAME}}... dos SKILL.md são preenchidos com esta identidade. */
    private readonly identity: AgentIdentity = DEFAULT_IDENTITY,
  ) {
    this.skillsDirs = Array.isArray(skillsDir) ? skillsDir : [skillsDir];
  }

  /** Carrega as skills de todas as camadas; a camada posterior sobrescreve a anterior. */
  loadAll(): SkillMetadata[] {
    const byName = new Map<string, SkillMetadata>();
    for (const [layer, dir] of this.skillsDirs.entries()) {
      for (const skill of this.loadDir(dir)) {
        const previous = byName.get(skill.name);
        if (previous && layer > 0 && path.dirname(previous.directory) !== path.dirname(skill.directory)) {
          this.logger.debug(`Skill "${skill.name}" de ${dir} sobrescreve a de ${path.dirname(previous.directory)}`);
        }
        byName.set(skill.name, skill);
      }
    }
    return [...byName.values()];
  }

  /** Carrega os metadados (frontmatter) das skills válidas de uma pasta. */
  private loadDir(skillsDir: string): SkillMetadata[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Não foi possível ler ${skillsDir}: ${errorMessage(error)}`);
      }
      return [];
    }

    const byName = new Map<string, SkillMetadata>();
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = path.join(skillsDir, entry.name);
      const filePath = path.join(directory, 'SKILL.md');

      // EC-02: pasta "fantasma" sem SKILL.md é ignorada silenciosamente.
      if (!fs.existsSync(filePath)) continue;

      const metadata = this.parseMetadata(filePath, directory);
      // EC-03: frontmatter inválido rejeita apenas esta skill, sem log fatal.
      if (!metadata) {
        this.logger.debug(`Skill em "${entry.name}" ignorada: frontmatter ausente ou inválido`);
        continue;
      }

      // EC-01: nomes duplicados — a última pasta (ordem alfabética) substitui a anterior.
      if (byName.has(metadata.name)) {
        this.logger.warn(`Skill duplicada "${metadata.name}" em "${entry.name}" substitui a anterior`);
      }
      byName.set(metadata.name, metadata);
    }
    return [...byName.values()];
  }

  /** Lê o corpo completo (instruções detalhadas, sem frontmatter) de uma skill. */
  loadContent(skill: SkillMetadata): string {
    const raw = fs.readFileSync(skill.filePath, 'utf8');
    const match = FRONTMATTER.exec(raw);
    return renderIdentity((match ? match[2]! : raw).trim(), this.identity);
  }

  private parseMetadata(filePath: string, directory: string): SkillMetadata | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const match = FRONTMATTER.exec(raw);
      if (!match) return null;
      let data: Record<string, unknown> | null;
      try {
        data = parseYaml(match[1]!) as Record<string, unknown> | null;
      } catch (error) {
        // Erro comum: "description: ex.: algo" sem aspas. Avisa o motivo (sem log fatal) e segue.
        this.logger.warn(`YAML inválido em ${path.basename(directory)}/SKILL.md (use aspas em textos com ":"): ${errorMessage(error).split('\n')[0]}`);
        return null;
      }
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      const description = typeof data?.description === 'string' ? renderIdentity(data.description.trim(), this.identity) : '';
      if (!name || !description) return null;
      return { name, description, directory, filePath, frontmatter: data ?? {} };
    } catch {
      return null;
    }
  }
}
