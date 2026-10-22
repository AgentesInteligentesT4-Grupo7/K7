/**
 * Estilos de imagem (spec image-generation RF-02): cada um usa um checkpoint SDXL e um
 * modelo de prompt próprio. O LLM escreve só a descrição da cena em inglês; o estilo
 * acrescenta as tags de qualidade e as travas de conteúdo seguro.
 */
export interface ImageStyle {
  id: string;
  descricao: string;
  /** Trecho do nome do checkpoint no ComfyUI (IMAGE_MODELS sobrescreve). */
  checkpoint: string;
  prefix: string;
  suffix: string;
  negative: string;
  /** Pony e Animagine pedem clip skip 2. */
  clipSkip: number;
  sampler: string;
  scheduler: string;
  cfg: number;
  /** Passos por qualidade (IMAGE_QUALITY). */
  steps: { rapido: number; qualidade: number };
}

/** Sempre no negativo, em todos os estilos (RF-13b). */
export const SAFETY_NEGATIVE = 'nsfw, nude, naked, nudity, explicit, sexual, cleavage, underwear, lingerie, gore, blood splatter';

const QUALITY_NEGATIVE = 'lowres, worst quality, low quality, blurry, jpeg artifacts, watermark, signature, text, logo, bad anatomy, bad hands, extra fingers, missing fingers, deformed';

// DreamShaper XL: pensado para as versões Turbo/Lightning (4–8 passos). Animagine e Pony: 20–28 passos.
export const IMAGE_STYLES: Record<string, ImageStyle> = {
  hq: {
    id: 'hq',
    descricao: 'história em quadrinhos ocidental: traço de nanquim, cores chapadas',
    checkpoint: 'dreamshaperXL',
    prefix: 'comic book art, bold ink outlines, flat vibrant colors, dynamic composition,',
    suffix: ', highly detailed, sharp focus',
    negative: `${QUALITY_NEGATIVE}, photo, photorealistic, 3d render`,
    clipSkip: 1,
    sampler: 'dpmpp_sde',
    scheduler: 'karras',
    cfg: 2,
    steps: { rapido: 6, qualidade: 8 },
  },
  ilustracao: {
    id: 'ilustracao',
    descricao: 'ilustração digital pintada (livro infantil, capa, conceito)',
    checkpoint: 'dreamshaperXL',
    prefix: 'digital illustration, painterly, soft lighting, storybook art,',
    suffix: ', highly detailed, beautiful composition',
    negative: `${QUALITY_NEGATIVE}, photo, photorealistic`,
    clipSkip: 1,
    sampler: 'dpmpp_sde',
    scheduler: 'karras',
    cfg: 2,
    steps: { rapido: 6, qualidade: 8 },
  },
  anime: {
    id: 'anime',
    descricao: 'anime colorido (estilo de série japonesa)',
    checkpoint: 'animagineXL',
    prefix: 'masterpiece, best quality, very aesthetic, anime style,',
    suffix: ', safe',
    negative: `${QUALITY_NEGATIVE}, nsfw, lowres, bad anatomy, worst quality, low quality, displeasing`,
    clipSkip: 2,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    cfg: 5,
    steps: { rapido: 20, qualidade: 28 },
  },
  manga: {
    id: 'manga',
    descricao: 'mangá em preto e branco com retícula',
    checkpoint: 'ponyDiffusionV6XL',
    prefix: 'score_9, score_8_up, score_7_up, source_anime, manga style, monochrome, greyscale, screentone, ink lines,',
    suffix: ', rating_safe',
    negative: `score_4, score_5, score_6, ${QUALITY_NEGATIVE}, color, rating_explicit, rating_questionable`,
    clipSkip: 2,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    cfg: 7,
    steps: { rapido: 20, qualidade: 28 },
  },
};

export const ASPECTS: Record<string, { width: number; height: number }> = {
  quadrado: { width: 1024, height: 1024 },
  retrato: { width: 832, height: 1216 },
  paisagem: { width: 1216, height: 832 },
  painel_largo: { width: 1344, height: 768 },
};

/** IMAGE_MODELS=hq:dreamshaperXL,anime:animagineXL → checkpoint por estilo. */
export function parseImageModels(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of (value ?? '').split(',')) {
    const [style, checkpoint] = pair.split(':').map((s) => s?.trim());
    if (style && checkpoint) result[style.toLowerCase()] = checkpoint;
  }
  return result;
}

export function buildPrompt(style: ImageStyle, description: string): { positive: string; negative: string } {
  const scene = description.trim().replace(/\s+/g, ' ').replace(/[.,;\s]+$/, '');
  return { positive: `${style.prefix} ${scene}${style.suffix}`, negative: `${style.negative}, ${SAFETY_NEGATIVE}` };
}
