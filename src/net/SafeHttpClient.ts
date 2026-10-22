import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { isBlockedAddress, safeLookup } from './NetworkGuard.js';

export class SafeHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeHttpError';
  }
}

export interface SafeRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  /** URL final, depois dos redirecionamentos. */
  url: string;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/**
 * Cliente HTTP para conteúdo da internet (spec web-search §12): só http/https, nunca endereços
 * internos (DNS validado na conexão e IP literal checado antes), cada redirecionamento revalidado,
 * timeout e limite de bytes. Usado por busca, leitura de páginas e notícias.
 */
export class SafeHttpClient {
  async request(url: string, options: SafeRequest): Promise<SafeResponse> {
    let current = SafeHttpClient.validate(url);
    const maxRedirects = options.maxRedirects ?? 5;
    for (let hop = 0; ; hop++) {
      const response = await this.once(current, options);
      if (response.redirect) {
        if (hop >= maxRedirects) throw new SafeHttpError(`Redirecionamentos demais (${maxRedirects})`);
        current = SafeHttpClient.validate(new URL(response.redirect, current).toString());
        // Depois de um redirect, a requisição vira GET (como no navegador).
        options = { ...options, method: 'GET', body: undefined };
        continue;
      }
      return { ...response.result!, url: current.toString() };
    }
  }

  static validate(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SafeHttpError(`URL inválida: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new SafeHttpError('Só são permitidos endereços http e https');
    if (parsed.username || parsed.password) throw new SafeHttpError('URL com usuário/senha não é permitida');
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new SafeHttpError('Endereço não permitido (rede local)');
    }
    if (net.isIP(host) && isBlockedAddress(host)) throw new SafeHttpError('Endereço não permitido (rede interna)');
    return parsed;
  }

  private once(url: URL, options: SafeRequest): Promise<{ redirect?: string; result?: Omit<SafeResponse, 'url'> }> {
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method: options.method ?? 'GET',
          headers: { 'user-agent': USER_AGENT, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.6', ...options.headers },
          lookup: safeLookup as never,
          timeout: options.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            resolve({ redirect: res.headers.location });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let done = false;
          const finish = (truncated: boolean) => {
            if (done) return;
            done = true;
            resolve({ result: { status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated } });
          };
          res.on('data', (chunk: Buffer) => {
            if (done) return;
            size += chunk.length;
            if (size > options.maxBytes) {
              chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBytes)));
              res.destroy();
              finish(true);
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => finish(false));
          res.on('error', (error) => (done ? undefined : reject(error)));
        },
      );
      req.on('timeout', () => req.destroy(new SafeHttpError(`Tempo esgotado (${Math.round(options.timeoutMs / 1000)} s) em ${url.hostname}`)));
      req.on('error', (error: NodeJS.ErrnoException) =>
        reject(error.code === 'EBLOCKED' ? new SafeHttpError('Endereço não permitido (resolve para a rede interna)') : error),
      );
      if (options.body) req.write(options.body);
      req.end();
    });
  }
}
