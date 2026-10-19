export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Remove null bytes e normaliza quebras de linha (EC-02 da spec de memória). */
export function sanitizeText(text: string): string {
  return text.replace(/\u0000/g, '').replace(/\r\n/g, '\n');
}

/** Trunca preservando o início e sinalizando o corte. */
export function truncate(text: string, maxChars: number, marker = '\n\n[... conteúdo truncado ...]'): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

/** Remove a sintaxe Markdown mais comum para leitura em voz (TTS). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (trecho de código omitido) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
