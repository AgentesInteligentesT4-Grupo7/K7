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
    // PreviewImage: fica na pasta temporária do ComfyUI (limpa quando ele reinicia); a cópia que vale é a do
    // tocador, com rotação. SaveImage acumulava todas as imagens no volume do container.
    '9': { class_type: 'PreviewImage', inputs: { images: ['8', 0] } },
  };
}

export interface Img2ImgParams extends Omit<Txt2ImgParams, 'width' | 'height'> {
  /** Nome da imagem já enviada ao ComfyUI (/upload/image). */
  image: string;
  /** Quanto redesenhar: 0 = igual à foto, 1 = ignora a foto. */
  denoise: number;
}

/**
 * Img2img (foto → desenho): a foto é redimensionada para ~1 megapixel (o tamanho que o SDXL conhece),
 * codificada no espaço latente e redesenhada no estilo com `denoise` < 1, mantendo composição e cores.
 */
export function img2imgWorkflow(p: Img2ImgParams): ComfyWorkflow {
  const base = txt2imgWorkflow({ ...p, width: 1024, height: 1024 });
  delete base['5'];
  return {
    ...base,
    '11': { class_type: 'LoadImage', inputs: { image: p.image } },
    '12': { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['11', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 64 } },
    '13': { class_type: 'VAEEncode', inputs: { pixels: ['12', 0], vae: ['4', 2] } },
    '3': { ...base['3']!, inputs: { ...base['3']!.inputs, denoise: p.denoise, latent_image: ['13', 0] } },
  };
}

/** Modelos do IP-Adapter (fichas de personagem): `npm run imagens:modelo -- personagens`. */
export const IPADAPTER_FILES = {
  clipVision: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
  plus: 'ip-adapter-plus_sdxl_vit-h.safetensors',
  face: 'ip-adapter-plus-face_sdxl_vit-h.safetensors',
};

export interface ReferenceInput {
  /** Imagens já enviadas ao ComfyUI, todas do mesmo personagem na mesma fase (rosto, meio corpo, corpo inteiro). */
  images: string[];
  /** Força do corpo/roupa (IP-Adapter Plus) e do rosto (Plus Face). */
  weight: number;
  faceWeight: number;
}

export interface GenerationParams extends Txt2ImgParams {
  /** Quantas versões gerar de uma vez (para a inspeção escolher a melhor). */
  batch?: number;
  /** Também salva miniaturas (para mandar ao modelo de visão sem pesar). */
  preview?: boolean;
  /** Img2img: foto de partida já enviada e quanto redesenhar. */
  base?: { image: string; denoise: number };
  /** Fichas de personagem: o modelo "olha" estas imagens enquanto desenha. */
  references?: ReferenceInput[];
}

/**
 * Workflow completo: txt2img ou img2img, com IP-Adapter encadeado por referência (corpo + rosto),
 * várias versões no mesmo lote e miniaturas opcionais. IDs fixos: 9 = imagens finais, 21 = miniaturas.
 */
export function generationWorkflow(p: GenerationParams): ComfyWorkflow {
  const batch = Math.max(1, p.batch ?? 1);
  const workflow = p.base ? img2imgWorkflow({ ...p, image: p.base.image, denoise: p.base.denoise }) : txt2imgWorkflow(p);
  if (p.base && batch > 1) {
    workflow['14'] = { class_type: 'RepeatLatentBatch', inputs: { samples: ['13', 0], amount: batch } };
    workflow['3']!.inputs.latent_image = ['14', 0];
  } else if (!p.base) {
    workflow['5']!.inputs.batch_size = batch;
  }

  let model: [string, number] = ['4', 0];
  if (p.references?.length) {
    workflow['30'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: IPADAPTER_FILES.clipVision } };
    workflow['31'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: IPADAPTER_FILES.plus } };
    workflow['32'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: IPADAPTER_FILES.face } };
    p.references.forEach((ref, i) => {
      // Várias imagens da mesma fase viram um lote (ImageBatch ajusta o tamanho); o IP-Adapter tira a média:
      // fica o que é constante no personagem (rosto, cabelo, roupa), não a pose de uma imagem só.
      let load: string = `${100 + i * 10}`;
      workflow[load] = { class_type: 'LoadImage', inputs: { image: ref.images[0] } };
      ref.images.slice(1).forEach((image, j) => {
        const next = `${100 + i * 10 + j + 1}`;
        const batch = `${150 + i * 10 + j + 1}`;
        workflow[next] = { class_type: 'LoadImage', inputs: { image } };
        workflow[batch] = { class_type: 'ImageBatch', inputs: { image1: [load, 0], image2: [next, 0] } };
        load = batch;
      });
      const combine = ref.images.length > 1 ? 'average' : 'concat';
      const apply = (id: string, ipadapter: string, weight: number) => {
        workflow[id] = {
          class_type: 'IPAdapterAdvanced',
          inputs: {
            model,
            ipadapter: [ipadapter, 0],
            image: [load, 0],
            clip_vision: ['30', 0],
            weight,
            weight_type: 'linear',
            combine_embeds: combine,
            // Entra depois dos primeiros passos e solta nos finais: a composição (enquadramento, pose, cenário)
            // vem da cena pedida; a ficha só molda o personagem. Desde o passo 0, copiava o close das referências.
            start_at: 0.25,
            end_at: 0.85,
            embeds_scaling: 'V only',
          },
        };
        model = [id, 0];
      };
      apply(`${50 + i}`, '31', ref.weight);
      if (ref.faceWeight > 0) apply(`${60 + i}`, '32', ref.faceWeight);
    });
  }
  workflow['3']!.inputs.model = model;

  if (p.preview) {
    workflow['20'] = { class_type: 'ImageScaleBy', inputs: { image: ['8', 0], upscale_method: 'bilinear', scale_by: 0.35 } };
    workflow['21'] = { class_type: 'PreviewImage', inputs: { images: ['20', 0] } };
  }
  return workflow;
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

  /** Enfileira o workflow, espera terminar e devolve o (primeiro) PNG gerado. */
  async run(workflow: ComfyWorkflow, timeoutMs: number): Promise<Buffer> {
    const outputs = await this.runOutputs(workflow, timeoutMs);
    return (outputs['9'] ?? Object.values(outputs)[0]!)[0]!;
  }

  /** Enfileira o workflow e devolve todas as imagens, por nó de saída (ex.: 9 = finais, 21 = miniaturas). */
  async runOutputs(workflow: ComfyWorkflow, timeoutMs: number): Promise<Record<string, Buffer[]>> {
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
      if (entry?.status?.completed && Object.values(entry.outputs ?? {}).some((o) => o.images?.length)) {
        const result: Record<string, Buffer[]> = {};
        for (const [node, output] of Object.entries(entry.outputs ?? {})) {
          for (const image of output.images ?? []) {
            const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
            const res = await this.request(`/view?${params}`);
            (result[node] ??= []).push(Buffer.from(await res.arrayBuffer()));
          }
        }
        return result;
      }
      await sleep(800);
    }
    throw new ImageServiceError(`A imagem não ficou pronta em ${Math.round(timeoutMs / 1000)} s (a primeira geração carrega o modelo na GPU e demora mais).`);
  }

  /** A extensão (custom node) está instalada? /object_info/<nó> devolve {} quando não está. */
  async hasNode(name: string): Promise<boolean> {
    try {
      const info = await this.get<Record<string, unknown>>(`/object_info/${name}`);
      return Boolean(info[name]);
    } catch {
      return false;
    }
  }

  /** Envia uma imagem de entrada (img2img) e devolve o nome com que o ComfyUI a guardou. */
  async uploadImage(data: Buffer, fileName: string): Promise<string> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)]), fileName);
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form });
    const body = (await res.json()) as { name?: string; subfolder?: string };
    if (!body.name) throw new ImageServiceError('O ComfyUI não aceitou a foto enviada.');
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
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
