import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { type ComfyUIClient, ImageServiceError, type ReferenceInput, generationWorkflow } from './ComfyUIClient.js';
import type { CandidateVerdict, ImageJudge } from './ImageJudge.js';
import { checkImagePrompt } from './ContentGuard.js';
import { ASPECTS, IMAGE_STYLES, type ImageStyle, buildPrompt } from './ImageStyles.js';

export type ImageQuality = 'rapido' | 'qualidade';

export interface ImageGeneratorOptions {
  comfy: ComfyUIClient;
  /** Pasta onde os PNGs ficam (workspace/imagens). */
  outputDir: string;
  /** Estilo → trecho do nome do checkpoint (IMAGE_MODELS). */
  models: Record<string, string>;
  defaultStyle: string;
  quality: ImageQuality;
  timeoutMs: number;
  /** Tempo ocioso até descarregar o modelo da GPU (IMAGE_IDLE_UNLOAD_MIN); 0 = nunca. */
  idleUnloadMs: number;
  /** API nativa do Ollama (sem /v1), para liberar a VRAM antes de gerar. */
  ollamaUrl?: string;
  fetcher?: typeof fetch;
  /** Inspeção com visão (anatomia e semelhança com a ficha); sem ela, a primeira versão é a escolhida. */
  judge?: ImageJudge;
}

/** Quanto a foto de base é redesenhada (denoise do img2img). */
export const STRENGTHS = { fiel: 0.45, equilibrado: 0.6, criativo: 0.75 } as const;
export type Strength = keyof typeof STRENGTHS;

const REFERENCE_NEGATIVE = 'multiple views, clone, duplicate character, same character twice, speech bubble, text, sound effects, signature, comic panel border';

export interface ImageRequest {
  /** Descrição visual em inglês (o estilo acrescenta qualidade e travas). */
  description: string;
  style?: string;
  aspect?: string;
  seed?: number;
  /** Foto de partida (img2img): a imagem sai no estilo, mantendo composição e cores; a proporção vem da foto. */
  baseImage?: { data: Buffer; name: string };
  strength?: Strength;
  /** Fichas de personagem (até 2 personagens, até 4 imagens cada): o desenho é condicionado nelas (IP-Adapter). */
  references?: Array<{ images: Array<{ data: Buffer; name: string; mime: string }> }>;
  /** Força das fichas (padrão 0,6: acima disso o desenho copia a composição da referência). */
  referenceWeight?: number;
  /** Quantas versões gerar para a inspeção escolher (1 = sem inspeção). */
  candidates?: number;
  /** Nome do personagem, para a inspeção comparar com a referência. */
  character?: string;
}

export interface GeneratedImageInfo {
  path: string;
  seed: number;
  style: string;
  checkpoint: string;
  width: number;
  height: number;
  ms: number;
  warning?: string;
  /** Resultado da inspeção (quando houve várias versões). */
  inspection?: { versions: number; rounds: number; chosen: number; anatomyOk: boolean; likeness?: number };
  /** Quantas fichas condicionaram o desenho. */
  references?: number;
}

/**
 * Gera imagens no ComfyUI, uma por vez (spec image-generation RF-01..RF-03, RF-10):
 * confere o prompt, libera a VRAM do Ollama, escolhe o checkpoint do estilo e
 * descarrega o modelo depois de um tempo ocioso.
 */
export class ImageGenerator {
  private readonly logger = new Logger('Imagens');
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private ipAdapterReady?: Promise<boolean>;

  constructor(private readonly options: ImageGeneratorOptions) {}

  generate(request: ImageRequest): Promise<GeneratedImageInfo> {
    checkImagePrompt(request.description);
    const run = this.queue.then(() => this.run(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async healthCheck(): Promise<string[]> {
    await this.options.comfy.healthCheck();
    return this.options.comfy.checkpoints();
  }

  private async run(request: ImageRequest): Promise<GeneratedImageInfo> {
    clearTimeout(this.idleTimer);
    const started = Date.now();
    const style = IMAGE_STYLES[request.style ?? this.options.defaultStyle] ?? IMAGE_STYLES[this.options.defaultStyle] ?? IMAGE_STYLES.hq!;
    const aspect = ASPECTS[request.aspect ?? 'quadrado'] ?? ASPECTS.quadrado!;
    const { checkpoint, warning } = await this.resolveCheckpoint(style);
    const seed = request.seed ?? randomInt(1, 2 ** 31);
    const prompt = buildPrompt(style, request.description);
    const { positive } = prompt;
    // Com ficha, o modelo tende a repetir o personagem ou copiar balões e texto da referência.
    const negative = request.references?.length ? `${prompt.negative}, ${REFERENCE_NEGATIVE}` : prompt.negative;
    const common = {
      checkpoint,
      positive,
      negative,
      seed,
      steps: style.steps[this.options.quality],
      cfg: style.cfg,
      sampler: style.sampler,
      scheduler: style.scheduler,
      clipSkip: style.clipSkip,
    };

    await this.freeOllama();
    const warnings = warning ? [warning] : [];
    const base = request.baseImage
      ? { image: await this.options.comfy.uploadImage(request.baseImage.data, request.baseImage.name), denoise: STRENGTHS[request.strength ?? 'equilibrado'] }
      : undefined;
    const references = await this.uploadReferences(request, warnings);
    const batch = Math.max(1, request.candidates ?? 1);
    const inspect = batch > 1 && Boolean(this.options.judge);
    this.logger.info(
      `🎨 ${style.id}${base ? ` a partir de foto (${request.strength ?? 'equilibrado'})` : ` ${aspect.width}×${aspect.height}`}${references.length ? ` · ${references.length} ficha(s)` : ''}${batch > 1 ? ` · ${batch} versões` : ''} seed ${seed} → ${checkpoint}`,
    );

    // Rodadas: gera o lote, a inspeção escolhe; se nenhuma tiver o corpo certo, tenta mais uma vez com outra semente.
    let chosen: { png: Buffer; seed: number; variant: number; verdict?: CandidateVerdict } | undefined;
    const rounds = inspect ? 2 : 1;
    let round = 0;
    for (; round < rounds; round++) {
      const roundSeed = round === 0 ? seed : randomInt(1, 2 ** 31);
      const outputs = await this.options.comfy.runOutputs(
        generationWorkflow({ ...common, seed: roundSeed, width: aspect.width, height: aspect.height, batch, preview: inspect, ...(base ? { base } : {}), references }),
        this.options.timeoutMs,
      );
      const finals = outputs['9'] ?? Object.values(outputs)[0] ?? [];
      if (!finals.length) throw new ImageServiceError('O ComfyUI terminou sem devolver imagem.');
      const previews = outputs['21'] ?? [];
      const verdict =
        inspect && previews.length === finals.length
          ? await this.options.judge!.judge(
              previews.map((p) => ({ mime: 'image/png', base64: p.toString('base64') })),
              { references: request.references?.flatMap((r) => r.images.slice(0, 1)).map((r) => ({ mime: r.mime, base64: r.data.toString('base64') })), character: request.character, scene: request.description },
            )
          : undefined;
      const index = verdict?.best ?? 0;
      const candidate = { png: finals[index]!, seed: roundSeed, variant: index + 1, ...(verdict ? { verdict: verdict.verdicts[index]! } : {}) };
      if (!chosen || (candidate.verdict?.anatomyOk && !chosen.verdict?.anatomyOk)) chosen = candidate;
      if (!verdict || chosen.verdict?.anatomyOk) break;
      this.logger.warn(`🧐 Nenhuma versão passou na inspeção de anatomia (rodada ${round + 1}); ${round + 1 < rounds ? 'gerando de novo' : 'entregando a melhor'}`);
    }
    if (chosen!.verdict && !chosen!.verdict.anatomyOk) {
      warnings.push(`A inspeção encontrou possível erro no corpo${chosen!.verdict.problem ? ` (${chosen!.verdict.problem})` : ''}; peça de novo se quiser outra tentativa.`);
    }

    const png = chosen!.png;
    const size = ImageGenerator.pngSize(png) ?? aspect;
    fs.mkdirSync(this.options.outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(this.options.outputDir, `${stamp}-${style.id}-${chosen!.seed}${batch > 1 ? `-v${chosen!.variant}` : ''}.png`);
    fs.writeFileSync(file, png);
    this.scheduleUnload();
    const ms = Date.now() - started;
    this.logger.info(`🖼️ Imagem pronta em ${(ms / 1000).toFixed(1)} s: ${file}`);
    return {
      path: file,
      seed: chosen!.seed,
      style: style.id,
      checkpoint,
      width: size.width,
      height: size.height,
      ms,
      ...(inspect ? { inspection: { versions: batch, rounds: Math.min(round + 1, rounds), chosen: chosen!.variant, anatomyOk: chosen!.verdict?.anatomyOk ?? true, likeness: chosen!.verdict?.likeness } } : {}),
      ...(references.length ? { references: references.length } : {}),
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    };
  }

  /** Sobe as imagens das fichas; sem a extensão do IP-Adapter no ComfyUI, segue sem elas e avisa. */
  private async uploadReferences(request: ImageRequest, warnings: string[]): Promise<ReferenceInput[]> {
    if (!request.references?.length) return [];
    this.ipAdapterReady ??= this.options.comfy.hasNode('IPAdapterAdvanced');
    if (!(await this.ipAdapterReady)) {
      this.ipAdapterReady = undefined;
      warnings.push('As fichas de personagem precisam do IP-Adapter no ComfyUI (npm run imagens:modelo -- personagens); desenhei só pela descrição.');
      return [];
    }
    // Com mais de uma ficha na mesma imagem, cada uma pesa menos (os traços se misturam).
    const share = 1 / Math.min(request.references.length, 2);
    const weight = (request.referenceWeight ?? 0.6) * share;
    const inputs: ReferenceInput[] = [];
    for (const character of request.references.slice(0, 2)) {
      const images: string[] = [];
      for (const image of character.images.slice(0, 4)) images.push(await this.options.comfy.uploadImage(image.data, image.name));
      if (images.length) inputs.push({ images, weight, faceWeight: weight * 0.6 });
    }
    return inputs;
  }

  /** Largura e altura do PNG (cabeçalho IHDR); no img2img o tamanho vem da foto. */
  static pngSize(png: Buffer): { width: number; height: number } | undefined {
    if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') return undefined;
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  }

  /** Checkpoint do estilo; se não estiver baixado, cai para o do estilo padrão e avisa (spec §6.3). */
  private async resolveCheckpoint(style: ImageStyle): Promise<{ checkpoint: string; warning?: string }> {
    const available = await this.options.comfy.checkpoints();
    const find = (wanted: string) => available.find((c) => c.toLowerCase().includes(wanted.toLowerCase()));
    const wanted = this.options.models[style.id] ?? style.checkpoint;
    const exact = find(wanted);
    if (exact) return { checkpoint: exact };
    for (const alternative of style.alternatives ?? []) {
      const found = find(alternative);
      if (found) return { checkpoint: found, ...(style.alternativeHint ? { warning: style.alternativeHint } : {}) };
    }

    const fallbackStyle = IMAGE_STYLES[this.options.defaultStyle];
    const fallback = find(this.options.models[this.options.defaultStyle] ?? fallbackStyle?.checkpoint ?? '') ?? available[0];
    if (!fallback) {
      throw new ImageServiceError('Nenhum modelo de imagem instalado no ComfyUI. Baixe um checkpoint SDXL (ex.: DreamShaper XL) para models/checkpoints.');
    }
    return { checkpoint: fallback, warning: `O modelo do estilo "${style.id}" (${wanted}) não está instalado; usei ${fallback}.` };
  }

  /** Pede ao Ollama para descarregar os modelos da GPU (keep_alive: 0). Falha aqui não impede a geração. */
  private async freeOllama(): Promise<void> {
    const { ollamaUrl } = this.options;
    if (!ollamaUrl) return;
    const fetcher = this.options.fetcher ?? fetch;
    try {
      const ps = (await (await fetcher(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(3000) })).json()) as { models?: Array<{ name: string }> };
      for (const model of ps.models ?? []) {
        await fetcher(`${ollamaUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: model.name, keep_alive: 0 }),
          signal: AbortSignal.timeout(10_000),
        });
        this.logger.info(`🧹 VRAM: ${model.name} descarregado do Ollama`);
      }
    } catch (error) {
      this.logger.debug(`Ollama não liberou a VRAM: ${errorMessage(error)}`);
    }
  }

  private scheduleUnload(): void {
    if (!this.options.idleUnloadMs) return;
    this.idleTimer = setTimeout(() => {
      this.options.comfy.free().then(
        () => this.logger.info('🧹 VRAM: modelo de imagem descarregado (ocioso)'),
        (error: unknown) => this.logger.debug(`ComfyUI não liberou a VRAM: ${errorMessage(error)}`),
      );
    }, this.options.idleUnloadMs);
    this.idleTimer.unref();
  }

  /**
   * Resposta com imagem entregue: libera a GPU (modelo do ComfyUI e modelos do Ollama) em `delayMs`,
   * para não sobrar memória presa entre um pedido e outro (voz, conversa local). Um novo pedido de imagem
   * dentro do prazo cancela a liberação (quadros seguidos de uma HQ não recarregam o modelo).
   */
  releaseGpuSoon(delayMs = 10_000): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.queue.then(async () => {
        try {
          await this.options.comfy.free();
          await this.freeOllama();
          this.logger.info('🧹 GPU liberada depois da entrega da imagem (ComfyUI e Ollama)');
        } catch (error) {
          this.logger.debug(`GPU não liberada: ${errorMessage(error)}`);
        }
      });
    }, delayMs);
    this.idleTimer.unref();
  }
}
