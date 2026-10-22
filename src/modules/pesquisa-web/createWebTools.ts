import type { Config } from '../../config/Config.js';
import { SafeHttpClient } from '../../net/SafeHttpClient.js';
import type { BaseTool } from '../../tools/BaseTool.js';
import { Logger } from '../../utils/Logger.js';
import { GoogleNewsClient } from './GoogleNews.js';
import { PageReader } from './PageReader.js';
import {
  DuckDuckGoSearchProvider,
  FallbackSearchProvider,
  type ISearchProvider,
  SearxngSearchProvider,
  TavilySearchProvider,
} from './SearchProviders.js';
import { NewsSearchTool, ReadPageTool, WebSearchTool } from './WebTools.js';

const logger = new Logger('Web');

/** Buscadores na ordem de SEARCH_PROVIDERS, com fallback (também usado pelas referências de personagem). */
export function createSearchProvider(config: Config, http: SafeHttpClient): FallbackSearchProvider {
  const { search } = config;
  const providers: ISearchProvider[] = [];
  for (const name of search.providers) {
    if (name === 'searxng') providers.push(new SearxngSearchProvider(search.searxngUrl, search.language));
    else if (name === 'duckduckgo') providers.push(new DuckDuckGoSearchProvider(http));
    else if (name === 'tavily' && search.tavilyApiKey) providers.push(new TavilySearchProvider(http, search.tavilyApiKey));
    else if (name === 'tavily') logger.debug('Tavily ignorado: TAVILY_API_KEY vazia');
  }
  logger.info(`🔎 Busca: ${providers.map((p) => p.name).join(' → ') || '(nenhum provider)'} | notícias: Google News`);
  return new FallbackSearchProvider(providers);
}

/** Ferramentas do módulo pesquisa-web: pesquisar_web, ler_pagina e buscar_noticias. */
export function createWebTools(config: Config, http = new SafeHttpClient()): BaseTool[] {
  const { search } = config;
  return [
    new WebSearchTool(createSearchProvider(config, http)),
    new ReadPageTool(new PageReader(http, { timeoutMs: search.timeoutMs, maxBytes: search.maxBytes }), search.pageMaxChars),
    new NewsSearchTool(new GoogleNewsClient(http, search.language, search.region)),
  ];
}
