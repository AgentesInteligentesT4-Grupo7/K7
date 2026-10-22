import { randomUUID } from 'node:crypto';
import { UserFacingError, errorMessage } from '../../errors/AppErrors.js';
import { sleep } from '../../utils/text.js';

/** ComfyUI fora do ar ou sem o modelo pedido: mensagem acionável, sem stack. */
export class ImageServiceError extends UserFacingError {}

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface Txt2ImgParams {
  checkpoint: string;
  positive: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
}

/** Workflow txt2img no formato da API do ComfyUI (spec image-generation RF-01). */
export function txt2imgWorkflow(p: Txt2ImgParams): ComfyWorkflow {
  const clip = p.clipSkip > 1 ? ['10', 0] : ['4', 1];
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.checkpoint } },
    ...(p.clipSkip > 1 ? { '10': { class_type: 'CLIPSetLastLayer', inputs: { stop_at_clip_layer: -p.clipSkip, clip: ['4', 1] } } } : {}),
    '5': { class_type: 'EmptyLatentImage', inputs: { width: p.width, height: p.height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.positive, clip } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip } },
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'parreiraclaw', images: ['8', 0] } },
  };
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

/** Cliente HTTP mínimo da API do ComfyUI: /prompt, /history, /view, /free, /object_info. */
export class ComfyUIClient {
  private readonly clientId = randomUUID();

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Checkpoints disponíveis na pasta models/checkpoints do ComfyUI. */
  async checkpoints(): Promise<string[]> {
    const info = await this.get<{ CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } } }>('/object_info/CheckpointLoaderSimple');
    return info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  }

  /** Enfileira o workflow, espera terminar e devolve o PNG gerado. */
  async run(workflow: ComfyWorkflow, timeoutMs: number): Promise<Buffer> {
    const queued = await this.post<{ prompt_id?: string; error?: { message?: string }; node_errors?: unknown }>('/prompt', { prompt: workflow, client_id: this.clientId });
    if (!queued.prompt_id) throw new ImageServiceError(`O ComfyUI recusou o pedido: ${queued.error?.message ?? 'workflow inválido'}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = await this.get<Record<string, HistoryEntry>>(`/history/${queued.prompt_id}`);
      const entry = history[queued.prompt_id];
      if (entry?.status?.status_str === 'error') {
        const detail = entry.status.messages?.find(([kind]) => kind === 'execution_error')?.[1]?.exception_message;
        throw new ImageServiceError(`A geração falhou no ComfyUI${detail ? `: ${String(detail).trim().slice(0, 200)}` : ''}`);
      }
      const image = entry?.status?.completed ? Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0] : undefined;
      if (image) {
        const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
        const res = await this.request(`/view?${params}`);
        return Buffer.from(await res.arrayBuffer());
      }
      await sleep(800);
    }
    throw new ImageServiceError(`A imagem não ficou pronta em ${Math.round(timeoutMs / 1000)} s (a primeira geração carrega o modelo na GPU e demora mais).`);
  }

  /** Descarrega os modelos da VRAM (spec RF-10). */
  async free(): Promise<void> {
    await this.post('/free', { unload_models: true, free_memory: true });
  }

  async healthCheck(): Promise<void> {
    await this.get('/system_stats');
  }

  private async get<T>(route: string): Promise<T> {
    return (await (await this.request(route)).json()) as T;
  }

  private async post<T = unknown>(route: string, body: unknown): Promise<T> {
    const res = await this.request(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, true);
    const text = await res.text();
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }

  private async request(route: string, init?: RequestInit, allowClientError = false): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${route}`, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new ImageServiceError(
        'O gerador de imagens (ComfyUI) está desligado. Ligue com "docker start comfyui".',
        `ComfyUI indisponível em ${this.baseUrl}: ${errorMessage(error)}`,
      );
    }
    if (!res.ok && !(allowClientError && res.status === 400)) throw new ImageServiceError(`O ComfyUI respondeu HTTP ${res.status} em ${route}.`);
    return res;
  }
}
