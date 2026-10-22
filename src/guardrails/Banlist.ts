/** Variações usadas para disfarçar letras (acentos, leetspeak). */
const LOOKALIKES: Record<string, string> = {
  a: 'aáàâãä4@',
  e: 'eéèêë3&',
  i: 'iíìîï1!|l',
  o: 'oóòôõö0',
  u: 'uúùûü',
  c: 'cç(',
  s: 's5$z',
  t: 't7+',
  g: 'g9',
  b: 'b8',
  l: 'l1|i',
  z: 'z2s',
};

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Regex que reconhece a palavra mesmo disfarçada: "p.a.l.a.v.r.a", "p a l a v r a", "p4l4vr4", letras repetidas.
 * Os separadores só valem entre letras da palavra, então palavras vizinhas não se juntam.
 */
function obfuscatedPattern(word: string): RegExp {
  const letters = [...plain(word)].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const parts = letters.map((c) => {
    const set = LOOKALIKES[c] ?? c;
    return `[${[...set].map(escape).join('')}]+`;
  });
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('[\\s._*~-]{0,2}')}(?![\\p{L}\\p{N}])`, 'giu');
}

export interface BanlistHit {
  word: string;
  text: string;
}

/** Palavras proibidas da fita, com normalização contra ofuscação (spec guardrails RF-03). */
export class Banlist {
  private readonly patterns: Array<{ word: string; re: RegExp }>;

  constructor(words: string[]) {
    this.patterns = words.filter((w) => plain(w).trim()).map((word) => ({ word, re: obfuscatedPattern(word) }));
  }

  get size(): number {
    return this.patterns.length;
  }

  find(text: string): BanlistHit[] {
    const hits: BanlistHit[] = [];
    for (const { word, re } of this.patterns) {
      for (const match of text.matchAll(re)) hits.push({ word, text: match[0] });
    }
    return hits;
  }

  /** Troca cada ocorrência por asteriscos do mesmo tamanho. */
  mask(text: string): string {
    return this.patterns.reduce((out, { re }) => out.replace(re, (m) => '*'.repeat(m.length)), text);
  }
}
