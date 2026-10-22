import { spawn, spawnSync } from 'node:child_process';
import { errorMessage } from '../errors/AppErrors.js';

/** Checkpoints conhecidos por estilo (spec image-generation RF-14). Todos do Hugging Face, sem token. */
const CATALOG: Record<string, { repo: string; file: string; estilos: string }> = {
  hq: { repo: 'Lykon/dreamshaper-xl-v2-turbo', file: 'DreamShaperXL_Turbo_V2-SFW.safetensors', estilos: 'hq, ilustracao' },
  anime: { repo: 'cagliostrolab/animagine-xl-4.0', file: 'animagine-xl-4.0-opt.safetensors', estilos: 'anime' },
  realista: { repo: 'SG161222/RealVisXL_V5.0_Lightning', file: 'RealVisXL_V5.0_Lightning_fp16.safetensors', estilos: 'realista' },
};
const CONTAINER = 'comfyui';
const DEST = '/root/ComfyUI/models/checkpoints';

/**
 * `npm run imagens:modelo -- [hq|anime|realista]`: baixa o checkpoint para dentro do volume do ComfyUI
 * (o container precisa estar no ar), mostrando licença e tamanho e conferindo o SHA-256 do Hugging Face.
 * O estilo manga (Pony Diffusion V6 XL) fica no Civitai e exige token: baixe manualmente.
 */
async function main(): Promise<void> {
  const key = process.argv[2] ?? 'hq';
  const item = CATALOG[key];
  if (!item) {
    console.log(`Uso: npm run imagens:modelo -- <${Object.keys(CATALOG).join('|')}>`);
    process.exitCode = 1;
    return;
  }
  const running = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' }).stdout.trim();
  if (running !== 'true') throw new Error('O ComfyUI não está no ar. Suba com: docker compose -f servicos/comfyui/docker-compose.yml up -d');

  const info = (await (await fetch(`https://huggingface.co/api/models/${item.repo}?blobs=true`)).json()) as {
    cardData?: { license?: string };
    siblings?: Array<{ rfilename: string; size?: number; lfs?: { sha256: string } }>;
  };
  const file = info.siblings?.find((s) => s.rfilename === item.file);
  if (!file?.lfs?.sha256) throw new Error(`${item.file} não encontrado em ${item.repo}`);
  console.log(`📦 ${item.file} (${((file.size ?? 0) / 1e9).toFixed(2)} GB) de huggingface.co/${item.repo}`);
  console.log(`📜 Licença: ${info.cardData?.license ?? 'veja a página do modelo'} — estilos: ${item.estilos}`);

  const target = `${DEST}/${item.file}`;
  const exists = spawnSync('docker', ['exec', CONTAINER, 'test', '-f', target]).status === 0;
  if (!exists) {
    const url = `https://huggingface.co/${item.repo}/resolve/main/${item.file}`;
    // Baixa para .part e só renomeia depois do hash conferido: nunca fica um checkpoint pela metade.
    const code = await run('docker', ['exec', CONTAINER, 'curl', '-L', '--fail', '--retry', '3', '-C', '-', '-o', `${target}.part`, url]);
    if (code !== 0) throw new Error(`Download falhou (curl saiu com ${code}); rode de novo para continuar de onde parou.`);
    spawnSync('docker', ['exec', CONTAINER, 'mv', `${target}.part`, target]);
  }
  const sha = spawnSync('docker', ['exec', CONTAINER, 'sha256sum', target], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
  if (sha !== file.lfs.sha256) {
    spawnSync('docker', ['exec', CONTAINER, 'rm', '-f', target]);
    throw new Error(`SHA-256 não confere (esperado ${file.lfs.sha256}, obtido ${sha}); arquivo removido.`);
  }
  console.log(`✅ ${item.file} pronto e conferido (SHA-256 ok). O ComfyUI já enxerga o modelo.`);
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => spawn(command, args, { stdio: 'inherit' }).on('close', (code) => resolve(code ?? 1)));
}

main().catch((error: unknown) => {
  console.error(`❌ ${errorMessage(error)}`);
  process.exitCode = 1;
});
