import path from 'node:path';
import { ResponseAttachments } from '../../agent/ResponseAttachments.js';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import type { AttachmentService } from '../anexos/AttachmentService.js';
import type { CharacterReference, CharacterReferenceFinder } from './CharacterReference.js';
import { type ImageGenerator, STRENGTHS, type Strength } from './ImageGenerator.js';
import { ASPECTS, IMAGE_STYLES } from './ImageStyles.js';

/** Estilos que aceitam foto de base: só desenho (foto de pessoa real + estilo realista = montagem). */
const DRAWING_STYLES = Object.keys(IMAGE_STYLES).filter((id) => id !== 'realista');

/** Ferramenta `gerar_imagem` (spec image-generation RF-03): a imagem segue anexada à resposta. */
export class GenerateImageTool extends BaseTool {
  readonly name = 'gerar_imagem';
  readonly description =
    'Gera uma imagem na GPU local (ilustração, HQ, anime, mangá ou foto realista) e a envia ao usuário junto da resposta. ' +
    'Escreva "descricao" EM INGLÊS como tags visuais separadas por vírgula (personagem com aparência fixa, ação, ' +
    'cenário, enquadramento, iluminação), sem nomes de estilo. Para transformar uma foto enviada em desenho, passe o ID ' +
    'do anexo em "imagem_base" e descreva o que a foto mostra. Para personagem que já existe (desenho, anime, filme, jogo, ' +
    'livro), preencha SEMPRE "personagem" com "Nome (Obra)": a ferramenta busca referências na internet antes de desenhar. Nunca gere nudez, conteúdo sexual, violência gráfica ' +
    'ou pessoas reais em estilo realista. Reutilize o mesmo "seed" para variações consistentes da mesma cena.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      descricao: { type: 'string', description: 'Descrição visual em inglês, ex.: "young male mechanic, undercut black hair, leather jacket, running in a rainy neon alley, side view, night"' },
      estilo: { type: 'string', enum: Object.keys(IMAGE_STYLES), description: Object.values(IMAGE_STYLES).map((s) => `${s.id}: ${s.descricao}`).join('; ') },
      proporcao: { type: 'string', enum: Object.keys(ASPECTS), description: 'Formato: quadrado, retrato (vertical), paisagem ou painel_largo (HQ). Ignorado com imagem_base (vale a da foto)' },
      seed: { type: 'integer', description: 'Opcional: repete uma geração anterior (mesmo seed + mesma descrição = mesma imagem)' },
      legenda: { type: 'string', description: 'Opcional: legenda curta em português para a imagem' },
      personagem: { type: 'string', description: 'Personagem existente a desenhar, como "Nome (Obra)", ex.: "Ben Tennyson (Ben 10)". A aparência vem de referências da internet; "descricao" fica com a cena, a pose e a ação' },
      imagem_base: { type: 'integer', description: 'Opcional: ID do anexo (foto enviada pelo usuário) a transformar em desenho; a descrição deve dizer o que a foto mostra' },
      intensidade: {
        type: 'string',
        enum: Object.keys(STRENGTHS),
        description: 'Com imagem_base: fiel (parece a foto com acabamento de desenho), equilibrado (padrão) ou criativo (só a ideia geral da foto)',
      },
    },
    required: ['descricao'],
    additionalProperties: false,
  };

  constructor(
    private readonly generator: ImageGenerator,
    private readonly workspaceDir: string,
    /** Módulo anexos: de onde vem a foto de base (sem ele, só texto → imagem). */
    private readonly attachments?: AttachmentService,
    /** Módulo pesquisa-web: referências visuais de personagens existentes. */
    private readonly references?: CharacterReferenceFinder,
  ) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const baseImage = args.imagem_base !== undefined ? this.loadBase(Number(args.imagem_base), args.estilo as string | undefined) : undefined;
    const reference = typeof args.personagem === 'string' && args.personagem.trim() ? await this.findReference(args.personagem.trim()) : undefined;
    // Personagem existente: nome + ficha visual da referência vêm antes da cena (o que mais pesa no prompt).
    const description = reference ? `${reference.character}, ${reference.tags}, ${String(args.descricao)}` : String(args.descricao);
    const image = await this.generator.generate({
      description,
      style: (args.estilo as string | undefined) ?? (baseImage ? 'ilustracao' : undefined),
      aspect: args.proporcao as string | undefined,
      seed: typeof args.seed === 'number' ? Math.trunc(args.seed) : undefined,
      ...(baseImage ? { baseImage, strength: (Object.keys(STRENGTHS).includes(String(args.intensidade)) ? args.intensidade : 'equilibrado') as Strength } : {}),
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
        ...(reference ? { referencia: { personagem: reference.character, ficha: reference.tags, fontes: reference.sources } } : {}),
        ...(baseImage ? { a_partir_de: `anexo #${String(args.imagem_base)}`, intensidade: args.intensidade ?? 'equilibrado' } : {}),
        entrega: 'A imagem já será enviada ao usuário junto da sua resposta; não repita o caminho do arquivo.',
        ...(image.warning ? { aviso: image.warning } : {}),
      }),
    };
  }

  private async findReference(character: string): Promise<CharacterReference> {
    if (!this.references) {
      throw new ToolArgumentError('Para desenhar um personagem existente preciso buscar referências na internet, mas o módulo "pesquisa-web" está desligado. Peça ao usuário para descrever a aparência (ou mandar uma imagem dele).');
    }
    return this.references.find(character);
  }

  /** Foto do usuário atual (anexos), só para estilos de desenho. */
  private loadBase(id: number, style: string | undefined): { data: Buffer; name: string } {
    if (!this.attachments) throw new ToolArgumentError('Transformar foto exige o módulo "anexos" ligado.');
    if (style && !DRAWING_STYLES.includes(style)) {
      throw new ToolArgumentError(`Foto de base só vira desenho (${DRAWING_STYLES.join(', ')}); o estilo realista não é usado sobre fotos.`);
    }
    const userId = TaskContext.current()?.userId ?? '';
    const attachment = Number.isInteger(id) ? this.attachments.store.get(userId, id) : undefined;
    if (!attachment) throw new ToolArgumentError(`Anexo #${String(id)} não encontrado (use listar_anexos).`);
    if (attachment.kind !== 'image') throw new ToolArgumentError(`O anexo #${id} não é uma imagem.`);
    return { data: this.attachments.store.readFile(attachment), name: `base-${id}${path.extname(attachment.name) || '.jpg'}` };
  }
}
