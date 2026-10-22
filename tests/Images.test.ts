import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ResponseAttachments } from '../src/agent/ResponseAttachments.js';
import { TaskContext } from '../src/llm/orchestration/TaskContext.js';
import { TempFileManager } from '../src/utils/TempFileManager.js';
import { ImageOutputStrategy } from '../src/canais/telegram/output/strategies/ImageOutputStrategy.js';
import type { TelegramSender } from '../src/canais/telegram/output/TelegramSender.js';
import { Config } from '../src/config/Config.js';
import { ComfyUIClient, ImageServiceError, txt2imgWorkflow } from '../src/modules/imagens/ComfyUIClient.js';
import { ForbiddenImageError, checkImagePrompt } from '../src/modules/imagens/ContentGuard.js';
import { GenerateImageTool } from '../src/modules/imagens/GenerateImageTool.js';
import { ImageGenerator } from '../src/modules/imagens/ImageGenerator.js';
import { IMAGE_STYLES, SAFETY_NEGATIVE, buildPrompt, parseImageModels } from '../src/modules/imagens/ImageStyles.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** ComfyUI + Ollama falsos: registra as chamadas; a imagem fica pronta na 2ª consulta ao histórico. */
function fakeServices(checkpoints: string[] = ['dreamshaperXL_v21TurboDPMSDE.safetensors', 'animagine-xl-4.0-opt.safetensors']) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  let polls = 0;
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    if (url.endsWith('/upload/image')) return json({ name: ((body as FormData).get('image') as File).name, subfolder: '', type: 'input' });
    if (url.endsWith('/object_info/CheckpointLoaderSimple')) return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } });
    if (url.endsWith('/prompt')) return json({ prompt_id: 'p1' });
    if (url.includes('/history/p1')) {
      polls++;
      return json(polls < 2 ? {} : { p1: { status: { status_str: 'success', completed: true }, outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } });
    }
    if (url.includes('/view?')) return new Response(PNG);
    if (url.endsWith('/api/ps')) return json({ models: [{ name: 'qwen3:8b' }] });
    if (url.endsWith('/api/generate') || url.endsWith('/free') || url.endsWith('/system_stats')) return json({});
    return new Response('não encontrado', { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher };
}

function generator(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof ImageGenerator>[0]> = {}) {
  return new ImageGenerator({
    comfy: new ComfyUIClient('http://comfy', fetcher),
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), 'imagens-')),
    models: {},
    defaultStyle: 'hq',
    quality: 'rapido',
    timeoutMs: 5000,
    idleUnloadMs: 0,
    ollamaUrl: 'http://ollama',
    fetcher,
    ...extra,
  });
}

describe('Imagens: travas de conteúdo e estilos', () => {
  it('bloqueia sexual (com qualquer pessoa), menores em contexto sexual e gore; permite cenas comuns e pessoas reais em contexto neutro', () => {
    assert.throws(() => checkImagePrompt('anime girl, nude, beach'), ForbiddenImageError);
    assert.throws(() => checkImagePrompt('schoolgirl, sexy pose'), /menores é proibido/);
    assert.throws(() => checkImagePrompt('warrior, decapitated enemy, gore'), /violência gráfica/);
    assert.throws(() => checkImagePrompt('photorealistic photo of Elon Musk, nude'), /conteúdo sexual/);
    assert.doesNotThrow(() => checkImagePrompt('photorealistic portrait of Elon Musk giving a speech'));
    for (const ok of ['young mechanic running in a neon alley, rain, night', 'a little girl reading a book under a tree, storybook', 'knight fighting a dragon, epic']) {
      assert.doesNotThrow(() => checkImagePrompt(ok), ok);
    }
  });

  it('o estilo acrescenta tags de qualidade e o negativo de segurança sempre vai junto', () => {
    const manga = buildPrompt(IMAGE_STYLES.manga!, '  samurai under cherry blossoms. ');
    assert.equal(manga.positive, `${IMAGE_STYLES.manga!.prefix} samurai under cherry blossoms, rating_safe`);
    assert.ok(manga.negative.endsWith(SAFETY_NEGATIVE));
    assert.deepEqual(parseImageModels('hq:dreamshaper, anime : animagine, ruim'), { hq: 'dreamshaper', anime: 'animagine' });
  });

  it('workflow: clip skip 2 passa pelo CLIPSetLastLayer; clip skip 1 usa o CLIP do checkpoint', () => {
    const base = { checkpoint: 'x', positive: 'p', negative: 'n', width: 1024, height: 1024, seed: 1, steps: 6, cfg: 2, sampler: 's', scheduler: 'k' };
    const pony = txt2imgWorkflow({ ...base, clipSkip: 2 });
    assert.equal(pony['10']!.inputs.stop_at_clip_layer, -2);
    assert.deepEqual(pony['6']!.inputs.clip, ['10', 0]);
    const dream = txt2imgWorkflow({ ...base, clipSkip: 1 });
    assert.equal(dream['10'], undefined);
    assert.deepEqual(dream['6']!.inputs.clip, ['4', 1]);
  });

  it('IMAGE_* no .env: padrões e validação', () => {
    const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1', GEMINI_API_KEY: 'k' };
    const config = new Config(env);
    assert.equal(config.images.baseUrl, 'http://localhost:8188');
    assert.equal(config.images.quality, 'rapido');
    assert.ok(!config.modules.has('imagens'), 'sem perfil, imagens fica desligado (exige ComfyUI)');
    assert.throws(() => new Config({ ...env, IMAGE_QUALITY: 'ultra' }), /IMAGE_QUALITY/);
  });
});

describe('Imagens: geração no ComfyUI', () => {
  it('libera a VRAM do Ollama, usa o checkpoint do estilo, espera o histórico e salva o PNG', async () => {
    const { calls, fetcher } = fakeServices();
    const image = await generator(fetcher).generate({ description: 'red fox in a snowy forest', style: 'anime', aspect: 'retrato', seed: 42 });
    assert.equal(fs.readFileSync(image.path).toString('hex'), PNG.toString('hex'));
    assert.equal(image.checkpoint, 'animagine-xl-4.0-opt.safetensors');
    assert.deepEqual([image.width, image.height, image.seed], [832, 1216, 42]);
    assert.deepEqual(calls.find((c) => c.url.endsWith('/api/generate'))?.body, { model: 'qwen3:8b', keep_alive: 0 });
    const ollamaFreed = calls.findIndex((c) => c.url.endsWith('/api/generate'));
    const queued = calls.findIndex((c) => c.url.endsWith('/prompt'));
    assert.ok(ollamaFreed < queued, 'VRAM liberada antes de gerar');
    const workflow = (calls[queued]!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    assert.equal(workflow['3']!.inputs.steps, 20);
    assert.match(String(workflow['7']!.inputs.text), /nsfw/);
  });

  it('modelo do estilo ausente cai para o padrão com aviso; sem nenhum modelo, erro acionável', async () => {
    const { fetcher } = fakeServices(['dreamshaperXL_turbo.safetensors']);
    const image = await generator(fetcher).generate({ description: 'samurai', style: 'manga' });
    assert.equal(image.checkpoint, 'dreamshaperXL_turbo.safetensors');
    assert.match(image.warning!, /estilo "manga".*não está instalado/);
    await assert.rejects(generator(fakeServices([]).fetcher).generate({ description: 'samurai' }), /Nenhum modelo de imagem instalado/);
  });

  it('foto → desenho (img2img): envia a foto, parte dela em vez de tela vazia e usa a intensidade pedida', async () => {
    const { calls, fetcher } = fakeServices();
    const image = await generator(fetcher).generate({ description: 'family at the beach', style: 'anime', baseImage: { data: Buffer.from('jpg'), name: 'base-7.jpg' }, strength: 'fiel' });
    assert.equal(image.style, 'anime');
    const upload = calls.findIndex((c) => c.url.endsWith('/upload/image'));
    const queued = calls.findIndex((c) => c.url.endsWith('/prompt'));
    assert.ok(upload >= 0 && upload < queued, 'a foto sobe antes do pedido');
    const workflow = (calls[queued]!.body as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt;
    assert.deepEqual(workflow['11'], { class_type: 'LoadImage', inputs: { image: 'base-7.jpg' } });
    assert.equal(workflow['12']!.class_type, 'ImageScaleToTotalPixels');
    assert.deepEqual(workflow['3']!.inputs.latent_image, ['13', 0], 'o sampler parte da foto codificada');
    assert.equal(workflow['3']!.inputs.denoise, 0.45);
    assert.equal(workflow['5'], undefined, 'sem tela vazia');
  });

  it('estilo realista: usa o RealVisXL se baixado; senão o DreamShaper, com a dica de como baixar', async () => {
    const without = await generator(fakeServices(['DreamShaperXL_Turbo_V2-SFW.safetensors']).fetcher).generate({ description: 'mountain lake at sunrise', style: 'realista' });
    assert.equal(without.checkpoint, 'DreamShaperXL_Turbo_V2-SFW.safetensors');
    assert.match(without.warning!, /npm run imagens:modelo -- realista/);
    const { calls, fetcher } = fakeServices(['DreamShaperXL_Turbo_V2-SFW.safetensors', 'RealVisXL_V5.0_Lightning_fp16.safetensors']);
    const withModel = await generator(fetcher).generate({ description: 'mountain lake at sunrise', style: 'realista' });
    assert.deepEqual([withModel.checkpoint, withModel.warning], ['RealVisXL_V5.0_Lightning_fp16.safetensors', undefined]);
    const workflow = (calls.find((c) => c.url.endsWith('/prompt'))!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt;
    assert.match(String(workflow['6']!.inputs.text), /^RAW photo, photorealistic/);
    assert.match(String(workflow['7']!.inputs.text), /cartoon, anime/);
  });

  it('depois da entrega libera a GPU (ComfyUI + Ollama); nova imagem dentro do prazo cancela a liberação', async () => {
    const { calls, fetcher } = fakeServices();
    const gen = generator(fetcher);
    await gen.generate({ description: 'lighthouse', seed: 1 });
    const before = calls.length;
    gen.releaseGpuSoon(5);
    await gen.generate({ description: 'lighthouse again', seed: 2 });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.slice(before).filter((c) => c.url.endsWith('/free')).length, 0, 'cancelada pela nova geração');
    gen.releaseGpuSoon(5);
    await new Promise((r) => setTimeout(r, 30));
    const after = calls.slice(before).map((c) => c.url);
    assert.ok(after.some((u) => u.endsWith('/free')), 'ComfyUI liberado');
    assert.ok(after.filter((u) => u.endsWith('/api/generate')).length >= 2, 'Ollama descarregado (antes de gerar e na liberação)');
  });

  it('guarda só as 10 imagens mais recentes: a primeira gerada é a primeira apagada', async () => {
    const { fetcher } = fakeServices();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotacao-'));
    for (let i = 0; i < 3; i++) {
      const old = path.join(dir, `antiga-${i}.png`);
      fs.writeFileSync(old, PNG);
      fs.utimesSync(old, new Date(2020, 0, i + 1), new Date(2020, 0, i + 1));
    }
    const gen = generator(fetcher, { outputDir: dir, keep: 3 });
    const first = await gen.generate({ description: 'boat', seed: 1 });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['antiga-1.png', 'antiga-2.png', path.basename(first.path)].sort(), 'saiu a mais antiga');
    await gen.generate({ description: 'boat', seed: 2 });
    assert.ok(!fs.existsSync(path.join(dir, 'antiga-1.png')) && fs.existsSync(path.join(dir, 'antiga-2.png')));
    assert.equal(fs.readdirSync(dir).length, 3);
  });

  it('a limpeza de início da pasta temporária preserva as imagens', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-'));
    fs.mkdirSync(path.join(dir, 'imagens'));
    fs.writeFileSync(path.join(dir, 'imagens', 'a.png'), PNG);
    fs.writeFileSync(path.join(dir, 'audio-velho.ogg'), 'x');
    new TempFileManager(dir).initialize();
    assert.deepEqual(fs.readdirSync(dir), ['imagens']);
    assert.ok(fs.existsSync(path.join(dir, 'imagens', 'a.png')));
  });

  it('ComfyUI desligado e erro de execução viram mensagens amigáveis', async () => {
    const off = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(generator(off, { ollamaUrl: undefined }).generate({ description: 'castle' }), (e: unknown) => e instanceof ImageServiceError && /docker start comfyui/.test(e.userMessage));

    const { fetcher } = fakeServices();
    const failing = (async (input: string | URL, init?: RequestInit) =>
      String(input).includes('/history/')
        ? new Response(JSON.stringify({ p1: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } }))
        : fetcher(input, init)) as typeof fetch;
    await assert.rejects(generator(failing).generate({ description: 'castle' }), /falhou no ComfyUI: CUDA out of memory/);
  });

  it('pedido proibido é recusado antes de chegar à GPU', async () => {
    const { calls, fetcher } = fakeServices();
    await assert.rejects(Promise.resolve().then(() => generator(fetcher).generate({ description: 'nude woman' })), ForbiddenImageError);
    assert.equal(calls.length, 0);
  });

  it('uma geração por vez (fila)', async () => {
    const { fetcher } = fakeServices();
    let running = 0;
    let peak = 0;
    const slow = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith('/prompt')) {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
      }
      if (String(input).includes('/view?')) running--;
      return fetcher(input, init);
    }) as typeof fetch;
    const gen = generator(slow);
    await Promise.all([gen.generate({ description: 'a' }), gen.generate({ description: 'b' })]);
    assert.equal(peak, 1);
  });
});

describe('Imagens: ferramenta e entrega', () => {
  it('gerar_imagem anexa a imagem à resposta e devolve seed e estilo ao LLM', async () => {
    const { fetcher } = fakeServices();
    const gen = generator(fetcher);
    const tool = new GenerateImageTool(gen, os.tmpdir());
    const { result, images } = await ResponseAttachments.collect(() => tool.execute({ descricao: 'lighthouse at dusk', estilo: 'ilustracao', legenda: 'Farol' }));
    const output = JSON.parse(result.output) as Record<string, unknown>;
    assert.equal(output.estilo, 'ilustracao');
    assert.equal(typeof output.seed, 'number');
    assert.equal(images.length, 1);
    assert.equal(images[0]!.caption, 'Farol');
    await assert.rejects(tool.execute({ descricao: 'x', estilo: 'fotografia' }), /deve ser um de/);
  });

  it('imagem_base: pega a foto do usuário nos anexos; só vira desenho; recusa anexo que não é imagem', async () => {
    const { calls, fetcher } = fakeServices();
    const store = {
      get: (userId: string, id: number) =>
        userId !== '7' ? undefined : id === 3 ? { id: 3, kind: 'image', name: 'praia.jpg' } : id === 4 ? { id: 4, kind: 'pdf', name: 'a.pdf' } : undefined,
      readFile: () => Buffer.from('foto'),
    };
    const tool = new GenerateImageTool(generator(fetcher), os.tmpdir(), { attachments: { store } as never });
    const inChat = <T>(fn: () => Promise<T>) => TaskContext.run({ task: 'visao', privacy: 'pessoal', userId: '7' }, fn);
    const { result } = await inChat(() => ResponseAttachments.collect(() => tool.execute({ descricao: 'two friends on the beach', imagem_base: 3 })));
    const output = JSON.parse(result.output) as Record<string, unknown>;
    assert.deepEqual([output.estilo, output.a_partir_de, output.intensidade], ['ilustracao', 'anexo #3', 'equilibrado'], 'sem estilo, foto vira ilustração');
    assert.ok(calls.some((c) => c.url.endsWith('/upload/image')));
    await assert.rejects(inChat(() => tool.execute({ descricao: 'x', imagem_base: 3, estilo: 'realista' })), /só vira desenho/);
    await assert.rejects(inChat(() => tool.execute({ descricao: 'x', imagem_base: 4 })), /não é uma imagem/);
    await assert.rejects(inChat(() => tool.execute({ descricao: 'x', imagem_base: 9 })), /não encontrado/);
    await assert.rejects(new GenerateImageTool(generator(fetcher), os.tmpdir()).execute({ descricao: 'x', imagem_base: 3 }), /módulo "anexos"/);
  });

  it('Telegram: 1 imagem vira foto; 12 viram um álbum de 10 + 1 álbum de 2', async () => {
    const sent: string[] = [];
    const sender = {
      sendPhoto: async (_: number, file: string) => sent.push(`foto:${file}`),
      sendAlbum: async (_: number, photos: unknown[]) => sent.push(`album:${photos.length}`),
    } as unknown as TelegramSender;
    const strategy = new ImageOutputStrategy(sender);
    await strategy.send(1, [{ path: 'a.png' }]);
    await strategy.send(1, Array.from({ length: 12 }, (_, i) => ({ path: `${i}.png` })));
    assert.deepEqual(sent, ['foto:a.png', 'album:10', 'album:2']);
  });
});
