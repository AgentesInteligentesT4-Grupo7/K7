import path from 'node:path';
import { ResponseAttachments } from '../../agent/ResponseAttachments.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, type ToolResult } from '../../tools/BaseTool.js';
import type { ImageGenerator } from './ImageGenerator.js';
import { ASPECTS, IMAGE_STYLES } from './ImageStyles.js';

/** Ferramenta `gerar_imagem` (spec image-generation RF-03): a imagem segue anexada à resposta. */
export class GenerateImageTool extends BaseTool {
  readonly name = 'gerar_imagem';
  readonly description =
    'Gera uma imagem na GPU local (ilustração, HQ, anime ou mangá) e a envia ao usuário junto da resposta. ' +
    'Escreva "descricao" EM INGLÊS como tags visuais separadas por vírgula (personagem com aparência fixa, ação, ' +
    'cenário, enquadramento, iluminação), sem nomes de estilo. Nunca gere nudez, conteúdo sexual, violência gráfica ' +
    'ou pessoas reais em estilo realista. Reutilize o mesmo "seed" para variações consistentes da mesma cena.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      descricao: { type: 'string', description: 'Descrição visual em inglês, ex.: "young male mechanic, undercut black hair, leather jacket, running in a rainy neon alley, side view, night"' },
      estilo: { type: 'string', enum: Object.keys(IMAGE_STYLES), description: Object.values(IMAGE_STYLES).map((s) => `${s.id}: ${s.descricao}`).join('; ') },
      proporcao: { type: 'string', enum: Object.keys(ASPECTS), description: 'Formato: quadrado, retrato (vertical), paisagem ou painel_largo (HQ)' },
      seed: { type: 'integer', description: 'Opcional: repete uma geração anterior (mesmo seed + mesma descrição = mesma imagem)' },
      legenda: { type: 'string', description: 'Opcional: legenda curta em português para a imagem' },
    },
    required: ['descricao'],
    additionalProperties: false,
  };

  constructor(
    private readonly generator: ImageGenerator,
    private readonly workspaceDir: string,
  ) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const image = await this.generator.generate({
      description: String(args.descricao),
      style: args.estilo as string | undefined,
      aspect: args.proporcao as string | undefined,
      seed: typeof args.seed === 'number' ? Math.trunc(args.seed) : undefined,
    });
    ResponseAttachments.addImage({ path: image.path, ...(typeof args.legenda === 'string' && args.legenda.trim() ? { caption: args.legenda.trim() } : {}) });
    return {
      output: JSON.stringify({
        ok: true,
        arquivo: path.relative(this.workspaceDir, image.path).split(path.sep).join('/'),
        seed: image.seed,
        estilo: image.style,
        modelo: image.checkpoint,
        tamanho: `${image.width}x${image.height}`,
        segundos: Math.round(image.ms / 100) / 10,
        entrega: 'A imagem já será enviada ao usuário junto da sua resposta; não repita o caminho do arquivo.',
        ...(image.warning ? { aviso: image.warning } : {}),
      }),
    };
  }
}
