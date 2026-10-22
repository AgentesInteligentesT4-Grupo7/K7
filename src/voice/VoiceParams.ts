/**
 * Parâmetros de geração do Chatterbox. Ausente = padrão do servidor.
 * - exaggeration: intensidade da emoção (padrão 0,5);
 * - cfgWeight: aderência/ritmo; mais baixo = fala mais cadenciada e arrastada (padrão 0,5);
 * - temperature: variação da fala (padrão 0,8);
 * - speedFactor: velocidade final do áudio (1 = normal; < 1 mais lento);
 * - seed: mesma semente + mesmos parâmetros = mesmo resultado (compara só o efeito do ajuste).
 */
export interface VoiceParams {
  exaggeration?: number;
  cfgWeight?: number;
  temperature?: number;
  speedFactor?: number;
  seed?: number;
}

/** Valores do servidor quando o parâmetro não é enviado (base dos ajustes relativos). */
export const SERVER_DEFAULTS: Required<Omit<VoiceParams, 'seed'>> = { exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8, speedFactor: 1 };

const LIMITS: Record<keyof Omit<VoiceParams, 'seed'>, [number, number]> = {
  exaggeration: [0.25, 2],
  cfgWeight: [0.1, 1],
  temperature: [0.3, 1.5],
  speedFactor: [0.6, 1.5],
};

const round = (v: number) => Math.round(v * 100) / 100;
export const clampParam = (key: keyof typeof LIMITS, value: number) => round(Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], value)));

/** Valida um objeto lido do disco (.json da voz). */
export function sanitizeParams(raw: unknown): VoiceParams {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: VoiceParams = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const value = Number((raw as Record<string, unknown>)[key]);
    if (Number.isFinite(value)) out[key] = clampParam(key, value);
  }
  const seed = Number((raw as Record<string, unknown>).seed);
  if (Number.isInteger(seed) && seed > 0) out.seed = seed;
  return out;
}

/** "emoção 0,9 · ritmo 0,3 · velocidade 1,0" para mostrar ao usuário. */
export function describeParams(params: VoiceParams): string {
  const p = { ...SERVER_DEFAULTS, ...params };
  const n = (v: number) => v.toFixed(2).replace(/0$/, '').replace('.', ',');
  return `emoção ${n(p.exaggeration)} · ritmo ${n(p.cfgWeight)} · velocidade ${n(p.speedFactor)} · variação ${n(p.temperature)}`;
}

export interface Adjustment {
  params: VoiceParams;
  /** O que mudou, em português, para o relatório. */
  changes: string[];
  /** Pedido para igualar a duração ao original (depende da medição; quem chama aplica). */
  matchDuration: boolean;
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tons prontos: atalhos para combinações que funcionam juntas. */
const PRESETS: Record<string, { params: Omit<VoiceParams, 'seed'>; label: string }> = {
  narrador: { params: { exaggeration: 1.2, cfgWeight: 0.3, temperature: 0.85 }, label: 'tom narrador (empolgado e cadenciado)' },
  animado: { params: { exaggeration: 0.9, cfgWeight: 0.4 }, label: 'tom animado' },
  calmo: { params: { exaggeration: 0.3, cfgWeight: 0.6, speedFactor: 0.95 }, label: 'tom calmo' },
  suspense: { params: { exaggeration: 0.7, cfgWeight: 0.3, speedFactor: 0.9 }, label: 'tom de suspense' },
  normal: { params: { ...SERVER_DEFAULTS }, label: 'tom normal (padrão)' },
};

/**
 * Interpreta "/ajustar ..." em português ("mais emoção e mais lento", "narrador", "outra", "igualar")
 * ou em números ("emocao=0.9 ritmo=0.3 velocidade=0.9 variacao=0.8 semente=42").
 */
export function parseAdjustment(request: string, current: VoiceParams, random: () => number = Math.random): Adjustment {
  const text = plain(request);
  const params: VoiceParams = { ...current };
  const changes: string[] = [];
  const step = (key: keyof typeof LIMITS, delta: number, label: string) => {
    const before = params[key] ?? SERVER_DEFAULTS[key];
    params[key] = clampParam(key, before + delta);
    changes.push(`${label} (${String(before).replace('.', ',')} → ${String(params[key]).replace('.', ',')})`);
  };

  for (const [name, preset] of Object.entries(PRESETS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      Object.assign(params, preset.params);
      changes.push(preset.label);
    }
  }

  const numbers: Array<[RegExp, keyof typeof LIMITS, string]> = [
    [/emocao\s*=\s*([\d.,]+)/, 'exaggeration', 'emoção'],
    [/ritmo\s*=\s*([\d.,]+)/, 'cfgWeight', 'ritmo'],
    [/velocidade\s*=\s*([\d.,]+)/, 'speedFactor', 'velocidade'],
    [/variacao\s*=\s*([\d.,]+)/, 'temperature', 'variação'],
  ];
  for (const [re, key, label] of numbers) {
    const m = re.exec(text);
    if (m) {
      params[key] = clampParam(key, Number(m[1]!.replace(',', '.')));
      changes.push(`${label} = ${String(params[key]).replace('.', ',')}`);
    }
  }
  const seed = /semente\s*=\s*(\d+)/.exec(text);
  if (seed) {
    params.seed = Number(seed[1]);
    changes.push(`semente ${params.seed}`);
  }

  if (/mais (emocao|emocionad|empolga|energi|intens|express)/.test(text)) step('exaggeration', 0.25, 'mais emoção');
  if (/menos (emocao|emocionad|empolga|energi|intens|express)|mais (neutr|seco|contido)/.test(text)) step('exaggeration', -0.2, 'menos emoção');
  if (/mais (lento|devagar)|menos rapid/.test(text)) step('speedFactor', -0.1, 'mais lento');
  if (/mais (rapid|acelerad|depressa)|menos (lento|devagar)/.test(text)) step('speedFactor', 0.1, 'mais rápido');
  if (/mais (pausad|cadencia|arrastad|enfatic)|alongar|esticar|esticad/.test(text)) step('cfgWeight', -0.1, 'mais cadenciado');
  if (/menos (pausad|arrastad)|mais (fluid|corrid|direto)/.test(text)) step('cfgWeight', 0.1, 'mais fluido');
  if (/mais (natural|variad|solt)|menos robot/.test(text)) step('temperature', 0.1, 'mais variação');
  if (/mais (estavel|firme|constante)|menos variad/.test(text)) step('temperature', -0.1, 'menos variação');
  if (/\b(outra|outro|de novo|novamente|nova versao|variar)\b/.test(text) && !seed) {
    params.seed = 1 + Math.floor(random() * 2_000_000_000);
    changes.push('outra variação (nova semente)');
  }
  const matchDuration = /\b(igualar|iguale|mesmo tamanho|mesma duracao|mesmo tempo)\b/.test(text);
  return { params, changes, matchDuration };
}

/** Ajusta a velocidade para o gerado durar o mesmo que o original (o servidor estica/encolhe o áudio). */
export function speedToMatch(current: VoiceParams, generatedSeconds: number, originalSeconds: number): number {
  const speed = current.speedFactor ?? SERVER_DEFAULTS.speedFactor;
  return clampParam('speedFactor', speed * (generatedSeconds / originalSeconds));
}

export const ADJUST_HELP =
  'Não gostou? /ajustar mais emoção · menos emoção · mais lento · mais rápido · mais pausado · mais natural · igualar (mesma duração) · outra (nova variação) · narrador · animado · calmo · suspense · ou números: emocao=0.9 ritmo=0.3 velocidade=0.9';
