export type PiiKind = 'cpf' | 'cnpj' | 'email' | 'telefone' | 'cartao' | 'chave';

export interface PiiResult {
  text: string;
  /** Tipos encontrados (sem os valores: o log não pode vazar o que a máscara esconde). */
  found: PiiKind[];
}

const digits = (s: string) => s.replace(/\D/g, '');

function validCpf(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    if (((sum * 10) % 11) % 10 !== Number(d[len])) return false;
  }
  return true;
}

function validCnpj(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (const len of [12, 13]) {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0);
    const check = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (check !== Number(d[len])) return false;
  }
  return true;
}

function luhn(raw: string): boolean {
  const d = digits(raw);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

/** Ordem importa: CNPJ antes de CPF e de cartão (sequências de dígitos se sobrepõem). */
const RULES: Array<{ kind: PiiKind; re: RegExp; valid?: (s: string) => boolean; label: string }> = [
  { kind: 'chave', re: /\b(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abp]-[A-Za-z0-9-]{10,}|\d{8,10}:[A-Za-z0-9_-]{35})\b/g, label: '[CHAVE]' },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: '[EMAIL]' },
  { kind: 'cnpj', re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, valid: validCnpj, label: '[CNPJ]' },
  { kind: 'cpf', re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, valid: validCpf, label: '[CPF]' },
  { kind: 'cartao', re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: luhn, label: '[CARTÃO]' },
  { kind: 'telefone', re: /(?<![\d])(?:\+?55[\s-]?)?(?:\(?\d{2}\)?[\s-]?)?9?\d{4}[\s-]?\d{4}(?![\d])/g, label: '[TELEFONE]' },
];

/** Telefone só conta com formato de telefone (DDD ou separador), não qualquer número de 8 dígitos. */
const looksLikePhone = (s: string) => /[\s()+-]/.test(s.trim()) && digits(s).length >= 10;

/** Mascara dados pessoais e segredos (spec guardrails RF-02). */
export class PiiMasker {
  constructor(private readonly kinds: ReadonlySet<PiiKind> = new Set(RULES.map((r) => r.kind))) {}

  mask(text: string): PiiResult {
    const found = new Set<PiiKind>();
    let out = text;
    for (const rule of RULES) {
      if (!this.kinds.has(rule.kind)) continue;
      out = out.replace(rule.re, (match) => {
        const ok = rule.kind === 'telefone' ? looksLikePhone(match) : (rule.valid?.(match) ?? true);
        if (!ok) return match;
        found.add(rule.kind);
        return rule.label;
      });
    }
    return { text: out, found: [...found] };
  }
}
