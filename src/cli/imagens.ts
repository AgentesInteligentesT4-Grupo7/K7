import { spawn, spawnSync } from 'node:child_process';
import { errorMessage } from '../errors/AppErrors.js';

interface CatalogItem {
  repo: string;
  /** Caminho do arquivo no repositório do Hugging Face. */
  file: string;
  estilos: string;
  /** Pasta em ComfyUI/models (padrão: checkpoints). */
  dir?: string;
  /** Nome com que o arquivo fica no ComfyUI (padrão: o nome no repositório). */
  as?: string;
}

/** Modelos conhecidos (spec image-generation RF-14). Todos do Hugging Face, sem token. */
const CATALOG: Record<string, CatalogItem> = {
  hq: { repo: 'Lykon/dreamshaper-xl-v2-turbo', file: 'DreamShaperXL_Turbo_V2-SFW.safetensors', estilos: 'hq, ilustracao' },
  anime: { repo: 'cagliostrolab/animagine-xl-4.0', file: 'animagine-xl-4.0-opt.safetensors', estilos: 'anime' },
  realista: { repo: 'SG161222/RealVisXL_V5.0_Lightning', file: 'RealVisXL_V5.0_Lightning_fp16.safetensors', estilos: 'realista' },
  // Fichas de personagem (IP-Adapter): o desenho "olha" a imagem de referência do personagem.
  'clip-vision': {
    repo: 'h94/IP-Adapter',
    file: 'models/image_encoder/model.safetensors',
    dir: 'clip_vision',
    as: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors',
    estilos: 'fichas de personagem (codificador de imagem)',
  },
  ipadapter: { repo: 'h94/IP-Adapter', file: 'sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors', dir: 'ipadapter', estilos: 'fichas de personagem (corpo, roupa, cores)' },
  'ipadapter-rosto': { repo: 'h94/IP-Adapter', file: 'sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors', dir: 'ipadapter', estilos: 'fichas de personagem (rosto)' },
};

/** Pacote "personagens": extensão do IP-Adapter no ComfyUI + os três modelos. */
const BUNDLES: Record<string, string[]> = { personagens: ['clip-vision', 'ipadapter', 'ipadapter-rosto'] };
const IPADAPTER_NODE = { repo: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus', dir: '/root/ComfyUI/custom_nodes/ComfyUI_IPAdapter_plus' };

const CONTAINER = 'comfyui';
const MODELS = '/root/ComfyUI/models';

/**
 * `npm run imagens:modelo -- [hq|anime|realista|personagens]`: baixa para dentro do volume do ComfyUI
 * (o container precisa estar no ar), mostrando licença e tamanho e conferindo o SHA-256 do Hugging Face.
 * `personagens` também instala a extensão ComfyUI_IPAdapter_plus e reinicia o ComfyUI.
 * O estilo manga (Pony Diffusion V6 XL) fica no Civitai e exige token: baixe manualmente.
 */
async function main(): Promise<void> {
  const key = process.argv[2] ?? 'hq';
  const keys = BUNDLES[key] ?? (CATALOG[key] ? [key] : undefined);
  if (!keys) {
    console.log(`Uso: npm run imagens:modelo -- <${[...Object.keys(CATALOG), ...Object.keys(BUNDLES)].join('|')}>`);
    process.exitCode = 1;
    return;
  }
  const running = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' }).stdout.trim();
  if (running !== 'true') throw new Error('O ComfyUI não está no ar. Suba com: docker compose -f servicos/comfyui/docker-compose.yml up -d');

  for (const item of keys) await download(CATALOG[item]!);
  if (BUNDLES[key]) await installIpAdapterNode();
}

async function download(item: CatalogItem): Promise<void> {
  const info = (await (await fetch(`https://huggingface.co/api/models/${item.repo}?blobs=true`)).json()) as {
    cardData?: { license?: string };
    siblings?: Array<{ rfilename: string; size?: number; lfs?: { sha256: string } }>;
  };
  const file = info.siblings?.find((s) => s.rfilename === item.file);
  if (!file?.lfs?.sha256) throw new Error(`${item.file} não encontrado em ${item.repo}`);
  const name = item.as ?? item.file.split('/').pop()!;
  console.log(`📦 ${name} (${((file.size ?? 0) / 1e9).toFixed(2)} GB) de huggingface.co/${item.repo}`);
  console.log(`📜 Licença: ${info.cardData?.license ?? 'veja a página do modelo'} — para: ${item.estilos}`);

  const dir = `${MODELS}/${item.dir ?? 'checkpoints'}`;
  const target = `${dir}/${name}`;
  spawnSync('docker', ['exec', CONTAINER, 'mkdir', '-p', dir]);
  const exists = spawnSync('docker', ['exec', CONTAINER, 'test', '-f', target]).status === 0;
  if (!exists) {
    const url = `https://huggingface.co/${item.repo}/resolve/main/${item.file}`;
    // Baixa para .part e só renomeia depois do hash conferido: nunca fica um modelo pela metade.
    const code = await run('docker', ['exec', CONTAINER, 'curl', '-L', '--fail', '--retry', '3', '-C', '-', '-o', `${target}.part`, url]);
    if (code !== 0) throw new Error(`Download falhou (curl saiu com ${code}); rode de novo para continuar de onde parou.`);
    spawnSync('docker', ['exec', CONTAINER, 'mv', `${target}.part`, target]);
  }
  const sha = spawnSync('docker', ['exec', CONTAINER, 'sha256sum', target], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
  if (sha !== file.lfs.sha256) {
    spawnSync('docker', ['exec', CONTAINER, 'rm', '-f', target]);
    throw new Error(`SHA-256 não confere (esperado ${file.lfs.sha256}, obtido ${sha}); arquivo removido.`);
  }
  console.log(`✅ ${name} pronto e conferido (SHA-256 ok).`);
}

/** Extensão do IP-Adapter (custom node) dentro do volume do ComfyUI; reinicia para carregar. */
async function installIpAdapterNode(): Promise<void> {
  const exists = spawnSync('docker', ['exec', CONTAINER, 'test', '-d', IPADAPTER_NODE.dir]).status === 0;
  if (exists) {
    console.log('🔌 Extensão IPAdapter já instalada; atualizando...');
    await run('docker', ['exec', CONTAINER, 'git', '-C', IPADAPTER_NODE.dir, 'pull', '--ff-only']);
  } else {
    console.log(`🔌 Instalando a extensão ComfyUI_IPAdapter_plus (${IPADAPTER_NODE.repo})...`);
    const code = await run('docker', ['exec', CONTAINER, 'git', 'clone', '--depth', '1', IPADAPTER_NODE.repo, IPADAPTER_NODE.dir]);
    if (code !== 0) throw new Error(`git clone falhou (saiu com ${code})`);
  }
  console.log('🔄 Reiniciando o ComfyUI para carregar a extensão...');
  spawnSync('docker', ['restart', CONTAINER]);
  console.log('✅ Fichas de personagem prontas (IP-Adapter).');
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => spawn(command, args, { stdio: 'inherit' }).on('close', (code) => resolve(code ?? 1)));
}

main().catch((error: unknown) => {
  console.error(`❌ ${errorMessage(error)}`);
  process.exitCode = 1;
});
