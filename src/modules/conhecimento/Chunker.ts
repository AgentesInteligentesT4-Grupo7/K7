export interface ChunkOptions {
  /** Tamanho alvo de cada trecho, em caracteres. */
  size: number;
  /** Quanto do fim do trecho anterior se repete no começo do próximo (contexto entre cortes). */
  overlap: number;
}

export const DEFAULT_CHUNKS: ChunkOptions = { size: 900, overlap: 150 };

/** Quebra um bloco grande demais em frases (e, em último caso, no tamanho bruto). */
function splitLong(block: string, size: number): string[] {
  if (block.length <= size) return [block];
  const sentences = block.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [block];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > size) {
      if (current.trim()) out.push(current.trim());
      current = '';
      for (let i = 0; i < sentence.length; i += size) out.push(sentence.slice(i, i + size).trim());
      continue;
    }
    if ((current + sentence).length > size && current.trim()) {
      out.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

/** Começo da sobreposição: o fim do trecho anterior, a partir de um limite de palavra. */
function tail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return overlap > 0 ? text : '';
  const cut = text.slice(-overlap);
  const space = cut.indexOf(' ');
  return space > 0 ? cut.slice(space + 1) : cut;
}

/**
 * Divide o texto em trechos de ~`size` caracteres respeitando parágrafos (e frases, quando um parágrafo
 * é maior que o trecho), com `overlap` caracteres repetidos entre trechos vizinhos.
 */
export function chunkText(text: string, options: ChunkOptions = DEFAULT_CHUNKS): string[] {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((b) => splitLong(b, options.size));
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > options.size) {
      chunks.push(current);
      const carried = tail(current, options.overlap);
      current = carried ? `${carried}\n\n${block}` : block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
