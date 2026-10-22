export interface GeneratedFile {
  filename: string;
  content: string;
}

export interface ParsedOutput {
  /** Texto fora das tags de arquivo. */
  text: string;
  files: GeneratedFile[];
}

const CLOSED_TAG = /<arquivo\s+nome\s*=\s*["']([^"'\n]+)["']\s*>([\s\S]*?)<\/arquivo>/gi;
const UNCLOSED_TAG = /<arquivo\s+nome\s*=\s*["']([^"'\n]+)["']\s*>([\s\S]*)$/i;
const ALLOWED_EXTENSIONS = new Set(['md', 'txt', 'json', 'csv', 'yaml', 'yml', 'html', 'xml', 'sql', 'py', 'ts', 'js']);

/**
 * Detecta tags `<arquivo nome="x.md">...</arquivo>` na resposta do LLM
 * e as separa do texto para envio como documento (FileOutputStrategy).
 */
export class FileTagParser {
  static parse(raw: string): ParsedOutput {
    const files: GeneratedFile[] = [];
    let text = raw.replace(CLOSED_TAG, (_match, name: string, content: string) => {
      files.push(FileTagParser.toFile(name, content));
      return '';
    });

    // Resposta truncada pelo LLM: tag aberta sem fechamento — o restante vira o arquivo.
    const unclosed = UNCLOSED_TAG.exec(text);
    if (unclosed) {
      files.push(FileTagParser.toFile(unclosed[1]!, unclosed[2]!));
      text = text.slice(0, unclosed.index);
    }

    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), files: files.filter((file) => file.content.length > 0) };
  }

  static sanitizeFilename(name: string): string {
    const base = name.split(/[/\\]/).pop() ?? '';
    let clean = base
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, '-')
      .replace(/^\.+/, '')
      .slice(0, 80);
    if (!clean) clean = 'documento';
    const extension = clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : '';
    return ALLOWED_EXTENSIONS.has(extension) ? clean : `${clean}.md`;
  }

  private static toFile(name: string, content: string): GeneratedFile {
    return { filename: FileTagParser.sanitizeFilename(name), content: content.replace(/^\s*\n/, '').trimEnd() };
  }
}
