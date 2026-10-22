const FENCE_CLOSE = '\n```';
const MAX_FENCE_OPENER = 20;

interface Cut {
  /** Índice onde o pedaço termina. */
  end: number;
  /** Índice onde o restante começa (pula separadores). */
  next: number;
}

/**
 * Fatia textos longos respeitando o limite do Telegram (4096) sem cortar
 * palavras ao meio: prefere quebras de parágrafo, depois de linha, depois espaço.
 * Blocos de código (```) abertos no corte são fechados e reabertos no próximo pedaço.
 */
export class TextChunker {
  constructor(private readonly limit = 4096) {
    if (limit < 100) throw new Error('Limite de chunk muito pequeno');
  }

  split(text: string): string[] {
    if (text.length <= this.limit) return [text];

    const chunks: string[] = [];
    let remaining = text;
    let openFence: string | null = null;

    while (remaining.length > 0) {
      const prefix = openFence ? `${openFence}\n` : '';
      if (prefix.length + remaining.length <= this.limit) {
        chunks.push(prefix + remaining);
        break;
      }

      const budget = this.limit - prefix.length - FENCE_CLOSE.length;
      const cut = TextChunker.findCut(remaining, budget);
      const body = remaining.slice(0, cut.end).trimEnd();
      remaining = remaining.slice(cut.next);

      // O prefixo apenas reabre o fence herdado; o estado é calculado sobre o corpo.
      openFence = TextChunker.trackFence(body, openFence);
      let piece = prefix + body;
      if (openFence) piece += FENCE_CLOSE;
      if (piece.trim()) chunks.push(piece);
    }
    return chunks;
  }

  private static findCut(text: string, budget: number): Cut {
    const window = text.slice(0, budget);
    const paragraph = window.lastIndexOf('\n\n');
    if (paragraph >= budget * 0.5) return { end: paragraph, next: TextChunker.skipNewlines(text, paragraph) };
    const line = window.lastIndexOf('\n');
    if (line >= budget * 0.3) return { end: line, next: TextChunker.skipNewlines(text, line) };
    const space = window.lastIndexOf(' ');
    if (space >= budget * 0.3) return { end: space, next: space + 1 };

    // Corte duro: evita partir um par surrogate (emoji) ao meio.
    let end = budget;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return { end, next: end };
  }

  private static skipNewlines(text: string, index: number): number {
    let next = index;
    while (text[next] === '\n') next++;
    return next;
  }

  /** Retorna a linha de abertura do fence se o pedaço terminar com um bloco de código aberto. */
  private static trackFence(piece: string, initial: string | null): string | null {
    let open = initial;
    for (const line of piece.split('\n')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('```')) continue;
      open = open ? null : trimmed.slice(0, MAX_FENCE_OPENER);
    }
    return open;
  }
}
