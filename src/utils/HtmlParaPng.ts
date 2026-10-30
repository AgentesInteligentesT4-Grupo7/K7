import type { Browser } from 'playwright-core';
import { UserFacingError, errorMessage } from '../errors/AppErrors.js';
import { Logger } from './Logger.js';

const logger = new Logger('HtmlParaPng');
const OCIOSO_MS = 2 * 60_000;

export interface HtmlParaPngOpcoes {
  /** Largura da página em pixels CSS (padrão 720). A altura acompanha o conteúdo. */
  largura?: number;
  /** Pixels por pixel CSS (padrão 2: nítido no celular). */
  escala?: number;
}

/**
 * Página HTML → imagem PNG ("print" de um layout), com o Chrome ou o Edge já instalados (playwright-core; nenhum
 * navegador é baixado). `K7_NAVEGADOR` aponta outro executável. A página roda sem rede: tudo o que ela usa vem no
 * próprio HTML (estilos, dados, SVG). Um navegador por processo, fechado depois de 2 min sem uso.
 */
export class HtmlParaPng {
  private browser?: Promise<Browser>;
  private ocioso?: NodeJS.Timeout;

  constructor(private readonly executavel = process.env.K7_NAVEGADOR?.trim() || undefined) {}

  async render(html: string, opcoes: HtmlParaPngOpcoes = {}): Promise<Buffer> {
    clearTimeout(this.ocioso);
    const browser = await this.abrir();
    const context = await browser.newContext({
      // Altura mínima: o print de página inteira fica com a altura do conteúdo.
      viewport: { width: opcoes.largura ?? 720, height: 16 },
      deviceScaleFactor: opcoes.escala ?? 2,
      offline: true,
      locale: 'pt-BR',
    });
    try {
      const page = await context.newPage();
      // Sem rede: nada de buscar fontes, imagens ou scripts de fora (o layout é autossuficiente).
      await page.route(/^(?!data:|about:)/, (route) => route.abort());
      await page.setContent(html, { waitUntil: 'load', timeout: 15_000 });
      await page.evaluate('document.fonts.ready.then(() => undefined)');
      return await page.screenshot({ type: 'png', fullPage: true, timeout: 15_000 });
    } finally {
      await context.close().catch(() => undefined);
      this.ocioso = setTimeout(() => void this.fechar(), OCIOSO_MS);
      this.ocioso.unref();
    }
  }

  async fechar(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    await (await browser?.catch(() => undefined))?.close().catch(() => undefined);
  }

  private abrir(): Promise<Browser> {
    this.browser ??= (async () => {
      const { chromium } = await import('playwright-core');
      const tentativas = this.executavel ? [{ executablePath: this.executavel }] : [{ channel: 'chrome' }, { channel: 'msedge' }];
      let ultimo: unknown;
      for (const t of tentativas) {
        try {
          const browser = await chromium.launch({ headless: true, ...t });
          browser.on('disconnected', () => (this.browser = undefined));
          return browser;
        } catch (error) {
          ultimo = error;
        }
      }
      throw new UserFacingError(
        'Não achei o Chrome nem o Edge para gerar a imagem. Instale um deles ou informe o caminho em K7_NAVEGADOR.',
        errorMessage(ultimo),
        { cause: ultimo },
      );
    })();
    this.browser.catch((error: unknown) => {
      this.browser = undefined;
      logger.warn(`Navegador para imagens indisponível: ${errorMessage(error)}`);
    });
    return this.browser;
  }
}

/** Uma instância por processo (as fitas dividem o mesmo navegador). */
export const htmlParaPng = new HtmlParaPng();
