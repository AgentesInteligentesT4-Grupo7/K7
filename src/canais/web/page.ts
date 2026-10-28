import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `web/index.html` na raiz do tocador (mesma profundidade a partir de src/ e de dist/). */
const PAGE = fileURLToPath(new URL('../../../web/index.html', import.meta.url));

/**
 * Lida a cada acesso: editar a página (ou o painel da fita) não exige reiniciar. O nonce libera só o
 * script/estilo da própria página e do painel da extensão da fita (CSP).
 */
export function renderPage(nonce: string, panel?: { script?: string; style?: string }): string {
  let html = fs.readFileSync(PAGE, 'utf8').replaceAll('__NONCE__', nonce);
  // O painel entra depois do script da página, que cria o window.K7 que ele usa.
  const { style, script } = panel ?? {};
  if (style) html = html.replace('</head>', () => `<style nonce="${nonce}">\n${inline(style, 'style')}</style>\n</head>`);
  if (script) html = html.replace('</body>', () => `<script nonce="${nonce}">\n${inline(script, 'script')}</script>\n</body>`);
  return html;
}

/** Conteúdo do arquivo pronto para ir dentro da tag (sem fechar a tag antes da hora). */
function inline(file: string, tag: 'script' | 'style'): string {
  return fs.readFileSync(file, 'utf8').replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');
}
