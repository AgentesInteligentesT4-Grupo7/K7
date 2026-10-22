import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { type ComfyUIClient, ImageServiceError, txt2imgWorkflow } from './ComfyUIClient.js';
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
}

export interface ImageRequest {
  /** Descrição visual em inglês (o estilo acrescenta qualidade e travas). */
  description: string;
  style?: string;
  aspect?: string;
  seed?: number;
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
    const { positive, negative } = buildPrompt(style, request.description);

    await this.freeOllama();
    this.logger.info(`🎨 ${style.id} ${aspect.width}×${aspect.height} seed ${seed} → ${checkpoint}`);
    const png = await this.options.comfy.run(
      txt2imgWorkflow({
        checkpoint,
        positive,
        negative,
        width: aspect.width,
        height: aspect.height,
        seed,
        steps: style.steps[this.options.quality],
        cfg: style.cfg,
        sampler: style.sampler,
        scheduler: style.scheduler,
        clipSkip: style.clipSkip,
      }),
      this.options.timeoutMs,
    );

    fs.mkdirSync(this.options.outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(this.options.outputDir, `${stamp}-${style.id}-${seed}.png`);
    fs.writeFileSync(file, png);
    this.scheduleUnload();
    const ms = Date.now() - started;
    this.logger.info(`🖼️ Imagem pronta em ${(ms / 1000).toFixed(1)} s: ${file}`);
    return { path: file, seed, style: style.id, checkpoint, width: aspect.width, height: aspect.height, ms, ...(warning ? { warning } : {}) };
  }

  /** Checkpoint do estilo; se não estiver baixado, cai para o do estilo padrão e avisa (spec §6.3). */
  private async resolveCheckpoint(style: ImageStyle): Promise<{ checkpoint: string; warning?: string }> {
    const available = await this.options.comfy.checkpoints();
    const find = (wanted: string) => available.find((c) => c.toLowerCase().includes(wanted.toLowerCase()));
    const wanted = this.options.models[style.id] ?? style.checkpoint;
    const exact = find(wanted);
    if (exact) return { checkpoint: exact };

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
}
