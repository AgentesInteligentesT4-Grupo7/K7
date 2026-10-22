import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ResponseAttachments } from '../src/agent/ResponseAttachments.js';
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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
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
  it('bloqueia sexual, menores em contexto sexual, gore e foto realista de pessoa real; permite cenas comuns', () => {
    assert.throws(() => checkImagePrompt('anime girl, nude, beach'), ForbiddenImageError);
    assert.throws(() => checkImagePrompt('schoolgirl, sexy pose'), /menores é proibido/);
    assert.throws(() => checkImagePrompt('warrior, decapitated enemy, gore'), /violência gráfica/);
    assert.throws(() => checkImagePrompt('photorealistic portrait of Elon Musk'), /pessoas reais/);
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
