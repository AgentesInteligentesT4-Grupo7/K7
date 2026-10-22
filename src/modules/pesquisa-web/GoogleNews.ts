import type { SafeHttpClient } from '../../net/SafeHttpClient.js';
import { decodeEntities, stripTags } from './HtmlText.js';
import { type SearchPeriod, SearchUnavailableError } from './SearchProviders.js';

export interface NewsItem {
  titulo: string;
  veiculo: string;
  data: string;
  url: string;
}

/** Notícias recentes pelo Google News RSS, sem chave (spec web-search RF-03). */
export class GoogleNewsClient {
  constructor(
    private readonly http: SafeHttpClient,
    private readonly language = 'pt-BR',
    private readonly region = 'BR',
  ) {}

  async search(topic: string, period: SearchPeriod, count: number): Promise<NewsItem[]> {
    const when = { dia: '1d', semana: '7d', mes: '30d', ano: '1y', qualquer: '' }[period];
    const q = when ? `${topic} when:${when}` : topic;
    const lang = this.language.split('-')[0];
    const params = new URLSearchParams({ q, hl: this.language, gl: this.region, ceid: `${this.region}:${lang === 'pt' ? 'pt-419' : lang}` });
    const res = await this.http.request(`https://news.google.com/rss/search?${params}`, { timeoutMs: 10_000, maxBytes: 2_000_000 });
    if (res.status !== 200) throw new SearchUnavailableError(`Google News HTTP ${res.status}`);
    return GoogleNewsClient.parse(res.body.toString('utf8')).slice(0, count);
  }

  /** Itens do RSS, do mais recente para o mais antigo, sem a mesma matéria repetida. */
  static parse(xml: string): NewsItem[] {
    const tag = (item: string, name: string) => {
      const raw = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item)?.[1] ?? '';
      return decodeEntities(raw.replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim();
    };
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
      const item = m[1]!;
      const veiculo = stripTags(tag(item, 'source'));
      let titulo = stripTags(tag(item, 'title'));
      if (veiculo && titulo.endsWith(` - ${veiculo}`)) titulo = titulo.slice(0, -(veiculo.length + 3));
      const date = new Date(tag(item, 'pubDate'));
      return { titulo, veiculo, data: Number.isNaN(date.getTime()) ? '' : date.toISOString(), url: tag(item, 'link') };
    });
    const seen = new Set<string>();
    return items
      .filter((i) => i.titulo && i.url)
      .sort((a, b) => b.data.localeCompare(a.data))
      .filter((i) => {
        const key = i.titulo.toLowerCase().replace(/\W+/g, ' ').trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((i) => ({ ...i, data: i.data.slice(0, 16).replace('T', ' ') }));
  }
}
