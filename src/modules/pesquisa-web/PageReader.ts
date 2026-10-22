import { PDFParse } from 'pdf-parse';
import type { SafeHttpClient } from '../../net/SafeHttpClient.js';
import { decodeBody, htmlTitle, htmlToText } from './HtmlText.js';

export interface PageContent {
  url: string;
  titulo: string;
  texto: string;
  truncado: boolean;
}

/** Erro de leitura que vira observação para o agente tentar outra fonte (spec web-search EC-04/EC-06). */
export class PageUnavailableError extends Error {}

/** Baixa uma página (HTML ou PDF) com o cliente seguro e extrai o texto principal (spec web-search RF-02). */
export class PageReader {
  constructor(
    private readonly http: SafeHttpClient,
    private readonly options: { timeoutMs: number; maxBytes: number },
  ) {}

  async read(url: string, maxChars: number): Promise<PageContent> {
    const res = await this.http.request(url, {
      timeoutMs: this.options.timeoutMs,
      maxBytes: this.options.maxBytes,
      headers: { accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new PageUnavailableError(`conteúdo indisponível (HTTP ${res.status}: bloqueio ou paywall)`);
    if (res.status >= 400) throw new PageUnavailableError(`conteúdo indisponível (HTTP ${res.status})`);
    if (res.truncated && !/html|text/i.test(res.contentType)) throw new PageUnavailableError(`arquivo grande demais (limite de ${Math.round(this.options.maxBytes / 1024 / 1024)} MB)`);

    let titulo = '';
    let texto: string;
    if (/pdf/i.test(res.contentType) || res.body.subarray(0, 5).toString('latin1') === '%PDF-') {
      const parser = new PDFParse({ data: new Uint8Array(res.body) });
      try {
        texto = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else if (/html|xml/i.test(res.contentType) || /^\s*</.test(res.body.subarray(0, 200).toString('latin1'))) {
      const html = decodeBody(res.body, res.contentType);
      titulo = htmlTitle(html);
      texto = htmlToText(html);
    } else if (/^text\//i.test(res.contentType) || /json/i.test(res.contentType)) {
      texto = decodeBody(res.body, res.contentType);
    } else {
      throw new PageUnavailableError(`tipo de conteúdo não suportado (${res.contentType || 'desconhecido'})`);
    }

    texto = texto.trim();
    if (texto.length < 200 && /enable javascript|ative o javascript|<noscript/i.test(res.body.toString('latin1').slice(0, 20000))) {
      throw new PageUnavailableError('conteúdo indisponível (página depende de JavaScript)');
    }
    if (!texto) throw new PageUnavailableError('conteúdo indisponível (página sem texto)');
    const truncado = texto.length > maxChars;
    return { url: res.url, titulo, texto: truncado ? `${texto.slice(0, maxChars)}\n[... texto truncado ...]` : texto, truncado };
  }
}
