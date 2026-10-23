import { type VoiceParams, clampParam } from './VoiceParams.js';

/**
 * Direção da fala: marcações entre parênteses ou colchetes no meio do texto mudam o jeito de falar
 * daquele ponto em diante, como numa leitura de roteiro:
 *
 *   (rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa longa) (sério) Agora falta resolver o contrato...
 *   (contexto: está gripado, de cama) (voz de pessoa doente) Hoje não vou conseguir ir. (tosse) Desculpa, pessoal.
 *
 * - tons prontos ("(animado)") ou descritos à vontade ("(voz de quem acabou de acordar)"): valem até o próximo tom;
 *   para combinar, junte na mesma marcação ("rápido, animado") ou cole as marcações ("(rápido)(animado)");
 * - pausas viram silêncio de verdade; efeitos ("(tosse)") são falados como som ("Cof, cof...");
 * - "(contexto: ...)" diz a situação de quem fala: orienta o diretor (LLM) e dá o tom aos trechos sem tom.
 * Cada trecho é gerado com seus próprios parâmetros. Parênteses com outras palavras ("(ver acima)") são texto normal.
 */

type StyleParams = Omit<VoiceParams, 'seed'>;

export interface SpeechSegment {
  text: string;
  /** Parâmetros do tom do trecho; `speedFactor` aqui multiplica a velocidade da voz. */
  params: StyleParams;
  /** Tons do trecho, como foram escritos (normalizados). */
  styles: string[];
  /** Tom descrito à vontade e sem tom pronto equivalente: quem gera traduz em parâmetros (LLM local). */
  description?: string;
  pauseAfterMs: number;
}

export interface SpeechScript {
  segments: SpeechSegment[];
  /** Havia alguma marcação reconhecida no texto. */
  directed: boolean;
  /** Havia pausa ou efeito: o ritmo já foi decidido por quem escreveu. */
  timed: boolean;
  /** Tons escritos no texto (prontos e descritos), na ordem. */
  tones: string[];
}

/**
 * Ritmo (cfgWeight) abaixo de ~0,45 junto com pouca emoção faz o Chatterbox às vezes não terminar a fala e
 * esticá-la ao dobro: os tons de pouca energia ficam em 0,45 e a lentidão vem da velocidade.
 */
const STYLES: Array<{ names: string[]; label: string; params: StyleParams }> = [
  { names: ['rapido', 'rapida', 'acelerado', 'acelerada', 'depressa'], label: 'rápido', params: { speedFactor: 1.2 } },
  { names: ['devagar', 'lento', 'lenta', 'pausado', 'pausada'], label: 'devagar', params: { speedFactor: 0.85, cfgWeight: 0.45 } },
  { names: ['animado', 'animada', 'empolgado', 'empolgada', 'feliz', 'alegre'], label: 'animado', params: { exaggeration: 0.9, cfgWeight: 0.4 } },
  { names: ['calmo', 'calma', 'tranquilo', 'tranquila', 'suave'], label: 'calmo', params: { exaggeration: 0.35, cfgWeight: 0.55, speedFactor: 0.95 } },
  { names: ['serio', 'seria', 'preocupado', 'preocupada'], label: 'sério', params: { exaggeration: 0.4, cfgWeight: 0.45, speedFactor: 0.95 } },
  { names: ['triste', 'chateado', 'chateada', 'desanimado', 'desanimada'], label: 'triste', params: { exaggeration: 0.4, cfgWeight: 0.45, speedFactor: 0.9 } },
  { names: ['doente', 'gripado', 'gripada', 'resfriado', 'resfriada', 'enfermo', 'enferma'], label: 'doente', params: { exaggeration: 0.3, cfgWeight: 0.45, speedFactor: 0.88 } },
  { names: ['cansado', 'cansada', 'exausto', 'exausta', 'sonolento', 'sonolenta'], label: 'cansado', params: { exaggeration: 0.3, cfgWeight: 0.45, speedFactor: 0.9 } },
  { names: ['bravo', 'brava', 'irritado', 'irritada', 'zangado', 'zangada'], label: 'bravo', params: { exaggeration: 1.1, cfgWeight: 0.45, speedFactor: 1.05 } },
  { names: ['nervoso', 'nervosa', 'ansioso', 'ansiosa', 'apressado', 'apressada'], label: 'nervoso', params: { exaggeration: 0.7, speedFactor: 1.15, temperature: 0.95 } },
  { names: ['suspense', 'misterioso', 'misteriosa'], label: 'suspense', params: { exaggeration: 0.7, cfgWeight: 0.35, speedFactor: 0.9 } },
  { names: ['forte', 'enfase', 'enfatico', 'enfatica', 'gritando', 'grito'], label: 'forte', params: { exaggeration: 1.3, cfgWeight: 0.35 } },
  { names: ['normal'], label: 'normal', params: {} },
];

/**
 * O modelo de voz (Chatterbox multilíngue) não tem efeitos sonoros: o efeito é falado como onomatopeia,
 * na mesma voz, como alguém imitando o som no meio da fala.
 */
const EFFECTS: Array<{ names: string[]; label: string; sound: string }> = [
  { names: ['tosse', 'tosses', 'tossindo', 'tossida', 'tossidas'], label: 'tosse', sound: 'Cof, cof...' },
  { names: ['pigarro', 'pigarreia', 'pigarreando'], label: 'pigarro', sound: 'Hum, hum.' },
  { names: ['espirro', 'espirra', 'espirrando'], label: 'espirro', sound: 'Atchim!' },
  { names: ['risada', 'risadas', 'risos', 'rindo', 'ri'], label: 'risada', sound: 'Ha ha ha!' },
  { names: ['suspiro', 'suspira', 'suspirando'], label: 'suspiro', sound: 'Ahhh...' },
  { names: ['bocejo', 'boceja', 'bocejando'], label: 'bocejo', sound: 'Aaahm...' },
];

const PAUSE_MS = { curta: 350, normal: 700, longa: 1300 };
const MAX_PAUSE_MS = 5000;
/** Reticências no meio da fala viram uma hesitação curta. */
const ELLIPSIS_PAUSE_MS = 450;

const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

type Marker =
  | { kind: 'style'; labels: string[]; params: StyleParams; description?: string }
  | { kind: 'pause'; ms: number }
  | { kind: 'effect'; label: string; sound: string }
  | { kind: 'context'; text: string };

/** Combina tons: o último vence, mas as velocidades se multiplicam ("rápido, calmo" continua rápido). */
export function mergeStyles(a: StyleParams, b: StyleParams): StyleParams {
  const merged = { ...a, ...b };
  if (a.speedFactor !== undefined && b.speedFactor !== undefined) merged.speedFactor = a.speedFactor * b.speedFactor;
  return merged;
}

function parsePause(token: string): number | undefined {
  const m = /^(?:pausa|silencio|respira)(?:\s+(curta|longa|de\s+)?\s*(?:(\d+(?:[.,]\d+)?)\s*(ms|s|seg|segundos?))?)?$/.exec(token);
  if (!m) return undefined;
  if (m[2]) {
    const value = Number(m[2].replace(',', '.'));
    return Math.min(MAX_PAUSE_MS, Math.round(m[3] === 'ms' ? value : value * 1000));
  }
  return m[1] === 'curta' ? PAUSE_MS.curta : m[1] === 'longa' ? PAUSE_MS.longa : PAUSE_MS.normal;
}

/** Tom pronto que aparece numa descrição livre ("voz de pessoa doente" → doente), se houver. */
export function toneFromKeywords(description: string): StyleParams | undefined {
  const found = plain(description)
    .split(/[^a-z]+/)
    .map((word) => STYLES.find((style) => style.names.includes(word)))
    .filter((style) => style !== undefined);
  return found.length ? found.reduce<StyleParams>((acc, s) => mergeStyles(acc, s.params), {}) : undefined;
}

/**
 * Descrição livre do jeito de falar: "(voz de ...)", "(tom de ...)", "(jeito de ...)", "(como quem ...)",
 * "(falando ...)", "(em tom ...)", "(voz: ...)". Começos genéricos como "(como ...)" ficam de fora:
 * "(como eu disse)" é texto.
 */
const FREE_TONE = /^(?:(?:voz|tom|jeito|estilo)\s*(?:de|do|da|:)|como\s+(?:quem|se)\s|falando\s|em\s+tom\s|com\s+(?:voz|tom)\s)/;

/** Conteúdo de uma marcação; `undefined` quando não é marcação (texto normal entre parênteses). */
function parseMarker(inner: string): Marker | undefined {
  const context = /^\s*contexto\s*:\s*(.+)$/is.exec(inner);
  if (context) return { kind: 'context', text: context[1]!.trim() };
  const normalized = plain(inner);
  if (FREE_TONE.test(normalized)) {
    const params = toneFromKeywords(inner);
    return { kind: 'style', labels: [inner.trim()], params: params ?? {}, ...(params ? {} : { description: inner.trim() }) };
  }
  const tokens = normalized.split(/\s*(?:,(?!\d)|;|\/|\+|\be\b)\s*/).filter(Boolean);
  if (!tokens.length) return undefined;
  const pauses = tokens.map(parsePause);
  if (pauses.every((ms) => ms !== undefined)) return { kind: 'pause', ms: Math.min(MAX_PAUSE_MS, pauses.reduce<number>((a, b) => a + b!, 0)) };
  if (tokens.length === 1) {
    const effect = EFFECTS.find((e) => e.names.includes(tokens[0]!));
    if (effect) return { kind: 'effect', label: effect.label, sound: effect.sound };
  }
  const styles = tokens.map((token) => STYLES.find((style) => style.names.includes(token)));
  if (styles.some((style) => !style)) return undefined;
  return { kind: 'style', labels: styles.map((s) => s!.label), params: styles.reduce<StyleParams>((acc, s) => mergeStyles(acc, s!.params), {}) };
}

const MARKER = /[([]\s*([^()[\]\n]{1,200}?)\s*[)\]]/g;
const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);
/** "Contexto: ..." na primeira linha também vale como marcação de contexto. */
const CONTEXT_LINE = /^\s*contexto\s*:\s*([^\n]+)\n/i;

/** Separa o contexto ("(contexto: ...)" ou a primeira linha "Contexto: ...") do texto a falar. */
export function extractContext(text: string): { context?: string; body: string } {
  const contexts: string[] = [];
  let body = text.replace(CONTEXT_LINE, (_, line: string) => (contexts.push(line.trim()), ''));
  body = body.replace(MARKER, (whole, inner: string) => {
    const marker = parseMarker(inner);
    if (marker?.kind !== 'context') return whole;
    contexts.push(marker.text);
    return ' ';
  });
  body = body.replace(/[ \t]+/g, ' ').trim();
  return contexts.length ? { context: contexts.join('; '), body } : { body };
}

export function parseDirection(text: string): SpeechScript {
  const segments: SpeechSegment[] = [];
  let style: { labels: string[]; params: StyleParams; description?: string } = { labels: [], params: {} };
  let buffer = '';
  let styleOpen = false; // a última coisa foi uma marcação de tom: a próxima se soma a ela
  let directed = false;
  let timed = false;
  const tones: string[] = [];

  const flush = (pauseMs = 0) => {
    const clean = buffer.replace(/\s+/g, ' ').trim();
    buffer = '';
    if (hasWords(clean)) {
      segments.push({
        text: clean,
        params: { ...style.params },
        styles: [...style.labels],
        ...(style.description ? { description: style.description } : {}),
        pauseAfterMs: pauseMs,
      });
    } else if (pauseMs && segments.length) segments[segments.length - 1]!.pauseAfterMs += pauseMs;
  };

  const body = extractContext(text);
  if (body.context) directed = true;
  let last = 0;
  for (const match of body.body.matchAll(MARKER)) {
    const marker = parseMarker(match[1]!);
    if (!marker || marker.kind === 'context') continue;
    directed = true;
    const before = body.body.slice(last, match.index);
    last = match.index! + match[0].length;
    if (hasWords(before)) styleOpen = false;
    buffer += before;
    if (marker.kind === 'pause') {
      timed = true;
      flush(marker.ms);
      styleOpen = false;
      continue;
    }
    if (marker.kind === 'effect') {
      timed = true;
      buffer += ` ${marker.sound} `;
      styleOpen = false;
      continue;
    }
    flush();
    tones.push(...marker.labels);
    const description = [styleOpen ? style.description : undefined, marker.description].filter(Boolean).join(', ');
    style = {
      labels: styleOpen ? [...style.labels, ...marker.labels] : marker.labels,
      params: styleOpen ? mergeStyles(style.params, marker.params) : marker.params,
      ...(description ? { description } : {}),
    };
    styleOpen = true;
  }
  buffer += body.body.slice(last);
  flush();

  // Reticências no meio de um trecho: hesitação curta (o modelo de voz quase não pausa nelas).
  const split = segments.flatMap((segment) => {
    const pieces: string[] = [];
    for (const piece of segment.text.split(/(?<=\.{3}|…)\s+(?=\S)/).filter(hasWords)) {
      // O som de um efeito fica colado no que vem depois ("Cof, cof... Desculpa"): sozinho o modelo erra.
      const previous = pieces[pieces.length - 1];
      if (previous !== undefined && EFFECTS.some((effect) => previous.endsWith(effect.sound))) pieces[pieces.length - 1] = `${previous} ${piece}`;
      else pieces.push(piece);
    }
    return pieces.map((piece, i) => ({
      ...segment,
      text: piece,
      pauseAfterMs: i < pieces.length - 1 ? ELLIPSIS_PAUSE_MS : segment.pauseAfterMs,
    }));
  });
  return { segments: split, directed, timed, tones };
}

/** Abaixo disso o Chatterbox erra sozinho (uma palavra sozinha sai repetida ou trocada): o trecho se junta ao vizinho. */
const MIN_SEGMENT_WORDS = 3;
const wordCount = (text: string) => text.split(/\s+/).filter(hasWords).length;

/** Junta duas falas; a pausa que havia entre elas vira reticências (o modelo pausa nelas). */
function join(first: string, second: string, paused: boolean): string {
  if (!paused || /[!?.]{3}$|[!?…]$/.test(first)) return `${first} ${second}`;
  return `${first.replace(/[.,;:]*$/, '')}... ${second}`;
}

/**
 * Trechos curtos demais para gerar sozinhos entram no anterior (com o tom dele) ou, se forem o primeiro,
 * no seguinte. A pausa depois do trecho curto continua sendo silêncio de verdade.
 */
export function mergeShortSegments(segments: SpeechSegment[]): SpeechSegment[] {
  const merged: SpeechSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && (wordCount(segment.text) < MIN_SEGMENT_WORDS || wordCount(previous.text) < MIN_SEGMENT_WORDS)) {
      // O tom é o do trecho que tem fala de verdade: o primeiro curto herda o do seguinte.
      const toneOf = wordCount(previous.text) < MIN_SEGMENT_WORDS ? segment : previous;
      merged[merged.length - 1] = {
        ...toneOf,
        text: join(previous.text, segment.text, previous.pauseAfterMs > 0),
        pauseAfterMs: segment.pauseAfterMs,
      };
    } else merged.push({ ...segment });
  }
  return merged;
}

/** Parâmetros finais do trecho sobre os ajustes da voz: o tom vence; a velocidade se multiplica. */
export function segmentParams(base: VoiceParams, segment: SpeechSegment): VoiceParams {
  const { speedFactor, ...rest } = segment.params;
  const params: VoiceParams = { ...base, ...rest };
  if (speedFactor !== undefined) params.speedFactor = clampParam('speedFactor', (base.speedFactor ?? 1) * speedFactor);
  return params;
}

const WORD = /[\p{L}\p{N}]+/gu;

type Piece = { text: string } | { raw: string; marker: Marker };

/** Texto em pedaços: trechos de texto e marcações reconhecidas (parênteses comuns ficam no texto). */
function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const marker = parseMarker(match[1]!);
    if (!marker) continue;
    out.push({ text: text.slice(last, match.index) }, { raw: match[0], marker });
    last = match.index! + match[0].length;
  }
  out.push({ text: text.slice(last) });
  return out;
}

/**
 * O tom escrito pela pessoa vence o do diretor: tira os tons do roteiro do diretor (ficam as pausas e os
 * efeitos dele) e recoloca os tons escritos antes da mesma palavra em que estavam. As palavras dos dois
 * textos são as mesmas (o diretor é conferido antes), então contar palavras acha o lugar certo.
 */
export function keepWrittenTones(written: string, directed: string): string {
  const anchors: Array<{ at: number; raw: string }> = [];
  let count = 0;
  for (const piece of pieces(extractContext(written).body)) {
    if ('text' in piece) count += piece.text.match(WORD)?.length ?? 0;
    else if (piece.marker.kind === 'style') anchors.push({ at: count, raw: piece.raw });
  }
  if (!anchors.length) return directed;

  let next = 0;
  const due = () => {
    let out = '';
    while (next < anchors.length && anchors[next]!.at <= count) out += `${anchors[next++]!.raw} `;
    return out;
  };
  count = 0;
  let out = due();
  for (const piece of pieces(directed)) {
    if (!('text' in piece)) {
      if (piece.marker.kind !== 'style') out += piece.raw;
      continue;
    }
    out += piece.text.replace(WORD, (word) => {
      const before = due();
      count++;
      return before + word;
    });
  }
  while (next < anchors.length) out += ` ${anchors[next++]!.raw}`;
  return out.replace(/\s+/g, ' ').trim();
}

/** O texto sem nenhuma marcação nem efeito: só as palavras escritas (para conferir o que o diretor devolveu). */
export function stripDirection(text: string): string {
  return extractContext(text)
    .body.replace(MARKER, (whole, inner: string) => (parseMarker(inner) ? ' ' : whole))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Marcações aceitas, para a ajuda e para o prompt do diretor. */
export const TONE_TAGS = STYLES.map((s) => `(${s.label})`);
export const EFFECT_TAGS = EFFECTS.map((e) => `(${e.label})`);
export const PAUSE_TAGS = ['(pausa curta)', '(pausa)', '(pausa longa)', '(pausa 2s)'];

export const DIRECTION_HELP = [
  '🎬 Jeito de falar: escreva marcações no meio do texto.',
  `Tons: ${TONE_TAGS.join(' ')}, ou descreva: (voz de quem acabou de acordar)`,
  `Pausas: ${PAUSE_TAGS.join(' ')}`,
  `Efeitos: ${EFFECT_TAGS.join(' ')}`,
  'Situação: (contexto: está gripado, de cama)',
  'Ex.: /falar (contexto: está gripado) (voz de pessoa doente) Hoje não vou conseguir ir. (tosse) Desculpa, pessoal.',
  'Sem marcações, o modelo local decide sozinho e mostra o roteiro para você editar.',
].join('\n');

/** Roteiro que o LLM escreveu para a fala, pronto para copiar, editar e mandar de novo. */
export const scriptMessage = (script: string, voice: string) =>
  `🎬 Jeito de falar que usei (copie, edite as marcações e mande de novo):\n\n/falar @${voice} ${script}`;
