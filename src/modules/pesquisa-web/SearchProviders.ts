import { errorMessage } from '../../errors/AppErrors.js';
import type { SafeHttpClient } from '../../net/SafeHttpClient.js';
import { Logger } from '../../utils/Logger.js';
import { decodeBody, decodeEntities, stripTags } from './HtmlText.js';

export type SearchPeriod = 'dia' | 'semana' | 'mes' | 'ano' | 'qualquer';

export interface SearchResult {
  titulo: string;
  url: string;
  trecho: string;
  data?: string;
  fonte: string;
}

/** Strategy de busca (spec web-search RF-04). */
export interface ISearchProvider {
  readonly name: string;
  search(query: string, count: number, period: SearchPeriod): Promise<SearchResult[]>;
}

export class SearchUnavailableError extends Error {}

const TIMEOUT = 10_000;
const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** SearXNG local (Docker), formato JSON habilitado no settings.yml. */
export class SearxngSearchProvider implements ISearchProvider {
  readonly name = 'searxng';
  constructor(
    private readonly baseUrl: string,
    private readonly language: string,
    /** O SearXNG roda na rede local: a checagem de SSRF vale para páginas da internet, não para ele. */
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(query: string, count: number, period: SearchPeriod): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, format: 'json', language: this.language });
    const range = { dia: 'day', semana: 'week', mes: 'month', ano: 'year' }[period as Exclude<SearchPeriod, 'qualquer'>];
    if (range) params.set('time_range', range);
    const res = await this.fetcher(`${this.baseUrl}/search?${params}`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 403) throw new SearchUnavailableError('SearXNG recusou JSON: habilite "search.formats: [html, json]" no settings.yml');
    if (!res.ok) throw new SearchUnavailableError(`SearXNG HTTP ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }> };
    return (data.results ?? []).slice(0, count).map((r) => ({
      titulo: r.title ?? '',
      url: r.url ?? '',
      trecho: r.content ?? '',
      ...(r.publishedDate ? { data: r.publishedDate.slice(0, 10) } : {}),
      fonte: domain(r.url ?? ''),
    }));
  }
}

/** DuckDuckGo (versão HTML, sem chave): alternativa enquanto o SearXNG não estiver no ar. */
export class DuckDuckGoSearchProvider implements ISearchProvider {
  readonly name = 'duckduckgo';
  constructor(private readonly http: SafeHttpClient) {}

  async search(query: string, count: number, period: SearchPeriod): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, kl: 'br-pt' });
    const df = { dia: 'd', semana: 'w', mes: 'm', ano: 'y' }[period as Exclude<SearchPeriod, 'qualquer'>];
    if (df) params.set('df', df);
    const res = await this.http.request(`https://html.duckduckgo.com/html/?${params}`, { timeoutMs: TIMEOUT, maxBytes: 1_500_000 });
    if (res.status !== 200) throw new SearchUnavailableError(`DuckDuckGo HTTP ${res.status}`);
    return DuckDuckGoSearchProvider.parse(decodeBody(res.body, res.contentType)).slice(0, count);
  }

  static parse(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
    for (const block of blocks) {
      if (/result--ad/.test(block.slice(0, 200))) continue;
      const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      if (!link) continue;
      let url = decodeEntities(link[1]!);
      const uddg = /[?&]uddg=([^&]+)/.exec(url)?.[1];
      if (uddg) url = decodeURIComponent(uddg);
      if (url.startsWith('//')) url = `https:${url}`;
      if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
      const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(block)?.[1] ?? '';
      results.push({ titulo: stripTags(link[2]!), url, trecho: stripTags(snippet), fonte: domain(url) });
    }
    return results;
  }
}

/** Tavily (nuvem, exige TAVILY_API_KEY): fallback opcional. */
export class TavilySearchProvider implements ISearchProvider {
  readonly name = 'tavily';
  constructor(
    private readonly http: SafeHttpClient,
    private readonly apiKey: string,
  ) {}

  async search(query: string, count: number, period: SearchPeriod): Promise<SearchResult[]> {
    const range = { dia: 'day', semana: 'week', mes: 'month', ano: 'year' }[period as Exclude<SearchPeriod, 'qualquer'>];
    const res = await this.http.request('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: count, ...(range ? { time_range: range } : {}) }),
      timeoutMs: TIMEOUT,
      maxBytes: 1_000_000,
    });
    if (res.status === 401) throw new SearchUnavailableError('Tavily recusou a chave (TAVILY_API_KEY)');
    if (res.status !== 200) throw new SearchUnavailableError(`Tavily HTTP ${res.status}`);
    const data = JSON.parse(res.body.toString('utf8')) as { results?: Array<{ title: string; url: string; content: string; published_date?: string }> };
    return (data.results ?? []).map((r) => ({
      titulo: r.title,
      url: r.url,
      trecho: r.content,
      ...(r.published_date ? { data: r.published_date.slice(0, 10) } : {}),
      fonte: domain(r.url),
    }));
  }
}

/** Tenta os providers em ordem (SEARCH_PROVIDERS); o primeiro que responder com resultados vence. */
export class FallbackSearchProvider implements ISearchProvider {
  readonly name = 'busca';
  private readonly logger = new Logger('Busca');

  constructor(private readonly providers: ISearchProvider[]) {}

  async search(query: string, count: number, period: SearchPeriod): Promise<SearchResult[]> {
    const failures: string[] = [];
    for (const provider of this.providers) {
      const started = Date.now();
      try {
        const results = (await provider.search(query, count, period)).filter((r) => r.url && r.titulo);
        this.logger.info(`🔎 ${provider.name}: "${query}" → ${results.length} resultado(s) em ${Date.now() - started}ms`);
        if (results.length) return results;
        failures.push(`${provider.name}: nenhum resultado`);
      } catch (error) {
        this.logger.warn(`🔎 ${provider.name} falhou: ${errorMessage(error)}`);
        failures.push(`${provider.name}: ${errorMessage(error)}`);
      }
    }
    if (failures.every((f) => f.endsWith('nenhum resultado'))) return [];
    throw new SearchUnavailableError(`busca indisponível (${failures.join('; ')})`);
  }
}
