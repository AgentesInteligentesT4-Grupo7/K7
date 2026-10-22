import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `web/index.html` na raiz do tocador (mesma profundidade a partir de src/ e de dist/). */
const PAGE = fileURLToPath(new URL('../../../web/index.html', import.meta.url));

/** Lida a cada acesso: editar a página não exige reiniciar. O nonce libera só o script/estilo da própria página (CSP). */
export function renderPage(nonce: string): string {
  return fs.readFileSync(PAGE, 'utf8').replaceAll('__NONCE__', nonce);
}
