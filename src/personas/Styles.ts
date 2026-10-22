import type { CatalogEntry, MarkdownCatalog } from './MarkdownCatalog.js';
import { type TextControls, sanitizeControls } from './TextControls.js';

export interface TextStyle {
  name: string;
  description: string;
  aliases: string[];
  /** Instruções de escrita injetadas no system prompt. */
  body: string;
  /** Níveis padrão do estilo (frontmatter `controles`). */
  controls: TextControls;
}

/** Palavras que indicam pedido de tom/registro ("em tom formal", "reescreva de forma infantil"). */
const CUES = /(?<![\p{L}\p{N}])(tom|estilo|linguagem|registro|escreva|escrever|reescreva|reescrever|texto|vers[aã]o|forma|jeito|modo|maneira)(?![\p{L}\p{N}])/iu;

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Estilos de texto (spec personas-styles §5.2): tocador `estilos/` + fita `estilos/`. */
export class StyleCatalog {
  constructor(private readonly catalog: MarkdownCatalog) {}

  list(): TextStyle[] {
    return this.catalog.list().map(StyleCatalog.toStyle);
  }

  get(name: string): TextStyle | undefined {
    const entry = this.catalog.get(normalize(name));
    return entry ? StyleCatalog.toStyle(entry) : undefined;
  }

  /** Estilo pedido na própria mensagem: alias + palavra de tom; vale o primeiro citado. */
  detect(text: string): TextStyle | undefined {
    if (!CUES.test(text)) return undefined;
    const plain = normalize(text);
    let best: { style: TextStyle; index: number } | undefined;
    for (const style of this.list()) {
      for (const alias of [style.name, ...style.aliases]) {
        const match = new RegExp(`(?<![\\p{L}\\p{N}])${normalize(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').exec(plain);
        if (match && (!best || match.index < best.index)) best = { style, index: match.index };
      }
    }
    return best?.style;
  }

  private static toStyle(entry: CatalogEntry): TextStyle {
    const aliases = entry.frontmatter.aliases;
    return {
      name: entry.name,
      description: entry.description,
      aliases: Array.isArray(aliases) ? aliases.map((a) => String(a).trim()).filter(Boolean) : [],
      body: entry.body,
      controls: sanitizeControls(entry.frontmatter.controles),
    };
  }
}
