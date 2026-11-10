import { createPublicKey, type JsonWebKeyInput, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Quem usa a administração pelo domínio público e o que pode fazer. O login (conta Google, código por e-mail) é do
 * Cloudflare Access; aqui só se confere a assinatura do Access e se decide o papel pelo e-mail:
 * - dono: tudo, inclusive quem entra (aba Pessoas) e instalar/remover fitas com código;
 * - editor: liga/desliga fitas, muda canais e acesso, bots e convites;
 * - leitor: só vê.
 * No próprio computador (127.0.0.1 com o token) é sempre dono.
 */
export type Papel = 'dono' | 'editor' | 'leitor';
export const PAPEIS: readonly Papel[] = ['dono', 'editor', 'leitor'];

export interface Pessoa {
  email: string;
  papel: Papel;
  desde: string;
  /** Veio de ADMIN_DONOS (.env): não dá para tirar pela página. */
  fixo?: boolean;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export class PessoasDaAdmin {
  constructor(
    private readonly arquivo: string,
    private readonly donosFixos: readonly string[] = [],
  ) {}

  listar(): Pessoa[] {
    const fixos: Pessoa[] = this.donosFixos.map((email) => ({ email, papel: 'dono', desde: '', fixo: true }));
    return [...fixos, ...this.salvas().filter((p) => !this.donosFixos.includes(p.email))];
  }

  papel(email: string): Papel | undefined {
    return this.listar().find((p) => p.email === email.toLowerCase())?.papel;
  }

  definir(email: string, papel: Papel): Pessoa {
    const limpo = email.trim().toLowerCase();
    if (!EMAIL.test(limpo)) throw new Error('E-mail inválido');
    if (!PAPEIS.includes(papel)) throw new Error('Papel inválido (dono, editor ou leitor)');
    if (this.donosFixos.includes(limpo)) throw new Error('Esse e-mail é dono pelo ADMIN_DONOS do .env');
    const pessoas = this.salvas().filter((p) => p.email !== limpo);
    const pessoa: Pessoa = { email: limpo, papel, desde: new Date().toISOString() };
    this.gravar([...pessoas, pessoa]);
    return pessoa;
  }

  remover(email: string): boolean {
    const limpo = email.trim().toLowerCase();
    if (this.donosFixos.includes(limpo)) throw new Error('Esse e-mail é dono pelo ADMIN_DONOS do .env');
    const pessoas = this.salvas();
    const resto = pessoas.filter((p) => p.email !== limpo);
    this.gravar(resto);
    return resto.length !== pessoas.length;
  }

  private salvas(): Pessoa[] {
    try {
      const dados = JSON.parse(fs.readFileSync(this.arquivo, 'utf8')) as { pessoas?: Pessoa[] };
      return (dados.pessoas ?? []).filter((p) => EMAIL.test(p.email) && PAPEIS.includes(p.papel));
    } catch {
      return [];
    }
  }

  private gravar(pessoas: Pessoa[]): void {
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
    const tmp = `${this.arquivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pessoas }, null, 2));
    fs.renameSync(tmp, this.arquivo);
  }
}

/**
 * Confere o JWT que o Cloudflare Access põe em `Cf-Access-Jwt-Assertion` (RS256, chaves públicas da equipe) e
 * devolve o e-mail de quem entrou. `equipe` = <nome>.cloudflareaccess.com; `aud` = a etiqueta AUD da aplicação.
 */
export class AcessoCloudflare {
  private chaves?: { porKid: Map<string, JsonWebKeyInput['key']>; em: number };

  /** `certsUrl`: só nos testes (padrão: https://<equipe>/cdn-cgi/access/certs). */
  constructor(private readonly options: { equipe: string; aud: string; agora?: () => number; certsUrl?: string }) {}

  async email(jwt: string): Promise<string> {
    const partes = jwt.split('.');
    if (partes.length !== 3) throw new Error('login do Access inválido');
    const [cab, corpo, assinatura] = partes as [string, string, string];
    const header = lerJson(cab) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) throw new Error('login do Access inválido');
    const chave = await this.chave(header.kid);
    const ok = verify('RSA-SHA256', Buffer.from(`${cab}.${corpo}`), createPublicKey({ key: chave, format: 'jwk' }), Buffer.from(assinatura, 'base64url'));
    if (!ok) throw new Error('login do Access com assinatura inválida');
    const p = lerJson(corpo) as { aud?: string | string[]; iss?: string; exp?: number; email?: string };
    const agora = (this.options.agora?.() ?? Date.now()) / 1000;
    const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!auds.includes(this.options.aud)) throw new Error('login do Access de outra aplicação');
    if (p.iss !== `https://${this.options.equipe}`) throw new Error('login do Access de outra equipe');
    if (!p.exp || p.exp < agora) throw new Error('login do Access expirado; entre de novo');
    if (!p.email) throw new Error('login do Access sem e-mail');
    return p.email.toLowerCase();
  }

  private async chave(kid: string): Promise<JsonWebKeyInput['key']> {
    const velhas = !this.chaves || Date.now() - this.chaves.em > 60 * 60_000;
    if (velhas || !this.chaves!.porKid.has(kid)) {
      const r = await fetch(this.options.certsUrl ?? `https://${this.options.equipe}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`não consegui as chaves do Access (${r.status})`);
      const { keys } = (await r.json()) as { keys: (JsonWebKeyInput['key'] & { kid: string })[] };
      this.chaves = { porKid: new Map(keys.map((k) => [k.kid, k])), em: Date.now() };
    }
    const chave = this.chaves!.porKid.get(kid);
    if (!chave) throw new Error('login do Access com chave desconhecida');
    return chave;
  }
}

function lerJson(parte: string): unknown {
  try {
    return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8'));
  } catch {
    throw new Error('login do Access inválido');
  }
}
