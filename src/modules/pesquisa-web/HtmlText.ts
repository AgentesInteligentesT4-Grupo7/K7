/**
 * Extração do texto principal de páginas HTML sem dependências (spec web-search RF-02):
 * remove scripts, menus, cabeçalho e rodapé, prefere <article>/<main> e mantém parágrafos e listas.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', copy: '©', reg: '®', deg: '°', ordm: 'º', ordf: 'ª',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', eacute: 'é', egrave: 'è', ecirc: 'ê', iacute: 'í', oacute: 'ó',
  ocirc: 'ô', otilde: 'õ', ouml: 'ö', uacute: 'ú', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ', Aacute: 'Á', Agrave: 'À', Acirc: 'Â',
  Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Ccedil: 'Ç', euro: '€',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return NAMED[entity] ?? NAMED[entity.toLowerCase()] ?? match;
  });
}

/** Decodifica o corpo respeitando o charset do cabeçalho ou do <meta> (sites brasileiros antigos usam ISO-8859-1). */
export function decodeBody(body: Buffer, contentType: string): string {
  const header = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder((header ?? meta ?? 'utf-8').toLowerCase()).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function htmlTitle(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return stripTags(og ?? title ?? '');
}

export function htmlToText(html: string): string {
  let doc = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');

  // Conteúdo principal: o maior <article>; senão <main>; senão <body>.
  const articles = [...doc.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]!);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(doc)?.[1];
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(doc)?.[1];
  const biggest = articles.sort((a, b) => stripTags(b).length - stripTags(a).length)[0];
  doc = biggest && stripTags(biggest).length > 400 ? biggest : (main ?? body ?? doc);

  const text = doc
    // Tags de texto corrido (link, negrito, nota) somem sem virar espaço: "Brasileiro, a mais", não "Brasileiro , a mais".
    .replace(/<\/?(a|span|b|i|em|strong|sup|sub|small|abbr|cite|code|mark|u|s|time|font|q)\b[^>]*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\/(p|div|section|h[1-6]|tr|blockquote|pre|table|ul|ol|figure|figcaption)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, lines) => line !== '' || (lines[i - 1] ?? '') !== '')
    .filter((line) => line !== '-')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
