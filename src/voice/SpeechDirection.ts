import { type VoiceParams, clampParam } from './VoiceParams.js';

/**
 * Direção da fala: marcações entre parênteses ou colchetes no meio do texto mudam o jeito de falar
 * daquele ponto em diante, como numa leitura de roteiro:
 *
 *   (rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa longa) (sério) Agora falta resolver o contrato...
 *
 * Cada trecho é gerado com seus próprios parâmetros e as pausas viram silêncio de verdade entre eles.
 * Um tom vale até o próximo tom; para combinar, junte na mesma marcação ("rápido, animado") ou cole as
 * marcações ("(rápido)(animado)"). Parênteses com outras palavras ("(ver acima)") são texto normal.
 */

export interface SpeechSegment {
  text: string;
  /** Parâmetros do tom do trecho; `speedFactor` aqui multiplica a velocidade da voz. */
  params: Omit<VoiceParams, 'seed'>;
  /** Tons do trecho, como foram escritos (normalizados). */
  styles: string[];
  pauseAfterMs: number;
}

export interface SpeechScript {
  segments: SpeechSegment[];
  /** Havia alguma marcação reconhecida no texto. */
  directed: boolean;
}

const STYLES: Array<{ names: string[]; label: string; params: Omit<VoiceParams, 'seed'> }> = [
  { names: ['rapido', 'rapida', 'acelerado', 'acelerada', 'depressa'], label: 'rápido', params: { speedFactor: 1.2 } },
  { names: ['devagar', 'lento', 'lenta', 'pausado', 'pausada'], label: 'devagar', params: { speedFactor: 0.85, cfgWeight: 0.35 } },
  { names: ['animado', 'animada', 'empolgado', 'empolgada', 'feliz', 'alegre'], label: 'animado', params: { exaggeration: 0.9, cfgWeight: 0.4 } },
  { names: ['calmo', 'calma', 'tranquilo', 'tranquila', 'suave'], label: 'calmo', params: { exaggeration: 0.35, cfgWeight: 0.55, speedFactor: 0.95 } },
  { names: ['serio', 'seria', 'preocupado', 'preocupada'], label: 'sério', params: { exaggeration: 0.4, cfgWeight: 0.45, speedFactor: 0.95 } },
  { names: ['triste'], label: 'triste', params: { exaggeration: 0.4, cfgWeight: 0.4, speedFactor: 0.9 } },
  { names: ['suspense', 'misterioso', 'misteriosa'], label: 'suspense', params: { exaggeration: 0.7, cfgWeight: 0.3, speedFactor: 0.9 } },
  { names: ['forte', 'enfase', 'enfatico', 'enfatica', 'gritando', 'grito'], label: 'forte', params: { exaggeration: 1.3, cfgWeight: 0.35 } },
  { names: ['normal'], label: 'normal', params: {} },
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

type StyleParams = Omit<VoiceParams, 'seed'>;
type Marker = { kind: 'style'; labels: string[]; params: StyleParams } | { kind: 'pause'; ms: number };

/** Combina tons: o último vence, mas as velocidades se multiplicam ("rápido, calmo" continua rápido). */
function mergeStyles(a: StyleParams, b: StyleParams): StyleParams {
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

/** Conteúdo de uma marcação; `undefined` quando não é marcação (texto normal entre parênteses). */
function parseMarker(inner: string): Marker | undefined {
  const tokens = plain(inner)
    .split(/\s*(?:,(?!\d)|;|\/|\+|\be\b)\s*/)
    .filter(Boolean);
  if (!tokens.length) return undefined;
  const pauses = tokens.map(parsePause);
  if (pauses.every((ms) => ms !== undefined)) return { kind: 'pause', ms: Math.min(MAX_PAUSE_MS, pauses.reduce<number>((a, b) => a + b!, 0)) };
  const styles = tokens.map((token) => STYLES.find((style) => style.names.includes(token)));
  if (styles.some((style) => !style)) return undefined;
  return { kind: 'style', labels: styles.map((s) => s!.label), params: styles.reduce<StyleParams>((acc, s) => mergeStyles(acc, s!.params), {}) };
}

const MARKER = /[([]\s*([^()[\]\n]{1,60}?)\s*[)\]]/g;
const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

export function parseDirection(text: string): SpeechScript {
  const segments: SpeechSegment[] = [];
  let style: { labels: string[]; params: Omit<VoiceParams, 'seed'> } = { labels: [], params: {} };
  let buffer = '';
  let styleOpen = false; // a última coisa foi uma marcação de tom: a próxima se soma a ela
  let directed = false;

  const flush = (pauseMs = 0) => {
    const clean = buffer.replace(/\s+/g, ' ').trim();
    buffer = '';
    if (hasWords(clean)) segments.push({ text: clean, params: { ...style.params }, styles: [...style.labels], pauseAfterMs: pauseMs });
    else if (pauseMs && segments.length) segments[segments.length - 1]!.pauseAfterMs += pauseMs;
  };

  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const marker = parseMarker(match[1]!);
    if (!marker) continue;
    directed = true;
    const before = text.slice(last, match.index);
    last = match.index! + match[0].length;
    if (hasWords(before)) styleOpen = false;
    buffer += before;
    if (marker.kind === 'pause') {
      flush(marker.ms);
      styleOpen = false;
      continue;
    }
    flush();
    style = styleOpen
      ? { labels: [...style.labels, ...marker.labels], params: mergeStyles(style.params, marker.params) }
      : { labels: marker.labels, params: marker.params };
    styleOpen = true;
  }
  buffer += text.slice(last);
  flush();

  // Reticências no meio de um trecho: hesitação curta (o modelo de voz quase não pausa nelas).
  const split = segments.flatMap((segment) => {
    const pieces = segment.text.split(/(?<=\.{3}|…)\s+(?=\S)/).filter(hasWords);
    return pieces.map((piece, i) => ({
      ...segment,
      text: piece,
      pauseAfterMs: i < pieces.length - 1 ? ELLIPSIS_PAUSE_MS : segment.pauseAfterMs,
    }));
  });
  return { segments: split, directed };
}

/** Abaixo disso o Chatterbox erra sozinho (uma palavra sozinha sai repetida ou trocada): o trecho se junta ao vizinho. */
const MIN_SEGMENT_WORDS = 3;
const wordCount = (text: string) => text.split(/\s+/).filter(hasWords).length;

/** Junta duas falas; a pausa que havia entre elas vira reticências (o modelo pausa nelas). */
function join(first: string, second: string, paused: boolean): string {
  if (!paused || /[!?]$/.test(first)) return `${first} ${second}`;
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

/** Remove as marcações (para conferir as palavras ou falar com um motor sem direção). */
export function stripDirection(text: string): string {
  return parseDirection(text)
    .segments.map((segment) => segment.text)
    .join(' ');
}

/** Marcações aceitas, para a ajuda e para o prompt do diretor. */
export const DIRECTION_TAGS = [...STYLES.map((s) => `(${s.label})`), '(pausa curta)', '(pausa)', '(pausa longa)', '(pausa 2s)'];

export const DIRECTION_HELP =
  `🎬 Para mudar o jeito de falar no meio do texto, use marcações: ${DIRECTION_TAGS.join(' ')}\n` +
  'Ex.: /falar (rápido, animado) Que notícia boa, conseguimos. (pausa) Pessoal! (pausa longa) (sério) Agora falta resolver o contrato...';

/** Roteiro que o LLM escreveu para a fala, pronto para copiar, editar e mandar de novo. */
export const scriptMessage = (script: string, voice: string) =>
  `🎬 Jeito de falar que usei (copie, edite as marcações e mande de novo):\n\n/falar @${voice} ${script}`;
