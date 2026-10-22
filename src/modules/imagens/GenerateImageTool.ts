import path from 'node:path';
import { ResponseAttachments } from '../../agent/ResponseAttachments.js';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import type { AttachmentService } from '../anexos/AttachmentService.js';
import type { CharacterReferenceFinder } from './CharacterReference.js';
import type { CharacterSheet, CharacterSheets } from './CharacterSheets.js';
import { type ImageGenerator, STRENGTHS, type Strength } from './ImageGenerator.js';
import { ASPECTS, IMAGE_STYLES } from './ImageStyles.js';

/** Estilos que aceitam foto de base: só desenho (foto de pessoa real + estilo realista = montagem). */
const DRAWING_STYLES = Object.keys(IMAGE_STYLES).filter((id) => id !== 'realista');

export interface GenerateImageToolDeps {
  /** Módulo anexos: de onde vem a foto de base (sem ele, só texto → imagem). */
  attachments?: AttachmentService;
  /** Módulo pesquisa-web: referências visuais de personagens existentes. */
  references?: CharacterReferenceFinder;
  /** Fichas de personagem salvas (consistência entre quadros da HQ). */
  sheets?: CharacterSheets;
  /** Versões geradas quando há personagem, para a inspeção escolher a melhor (IMAGE_CANDIDATES). */
  candidates?: number;
}

type CharacterImages = { images: Array<{ data: Buffer; name: string; mime: string }> };

/** Última imagem gerada por usuário: vira ficha de personagem original com criar_ficha_personagem. */
const lastImages = new Map<string, string>();
export const lastGeneratedImage = (userId: string) => lastImages.get(userId);

/** Ferramenta `gerar_imagem` (spec image-generation RF-03): a imagem segue anexada à resposta. */
export class GenerateImageTool extends BaseTool {
  readonly name = 'gerar_imagem';
  readonly description =
    'Gera uma imagem na GPU local (ilustração, HQ, anime, mangá ou foto realista) e a envia ao usuário junto da resposta. ' +
    'Escreva "descricao" EM INGLÊS como tags visuais separadas por vírgula (ação, pose, cenário, enquadramento, iluminação), sem nomes de estilo. ' +
    'Personagens: use "fichas" com os nomes de fichas salvas (listar_fichas) para manter rosto e corpo iguais em toda a história; ' +
    'para um personagem que já existe (desenho, anime, filme, jogo, livro) sem ficha, preencha "personagem" com "Nome (Obra)": a ' +
    'ferramenta busca referências na internet e cria a ficha. Para transformar uma foto enviada em desenho, passe o ID do anexo em ' +
    '"imagem_base". Nunca gere nudez, conteúdo sexual ou violência gráfica, nem imagem de pessoa real para enganar ou humilhar.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      descricao: { type: 'string', description: 'Cena em inglês: ação, pose, expressão, cenário, enquadramento, iluminação (a aparência dos personagens vem das fichas)' },
      estilo: { type: 'string', enum: Object.keys(IMAGE_STYLES), description: Object.values(IMAGE_STYLES).map((s) => `${s.id}: ${s.descricao}`).join('; ') },
      proporcao: { type: 'string', enum: Object.keys(ASPECTS), description: 'Formato: quadrado, retrato (vertical), paisagem ou painel_largo (HQ). Ignorado com imagem_base (vale a da foto)' },
      seed: { type: 'integer', description: 'Opcional: repete uma geração anterior (mesmo seed + mesma descrição = mesma imagem)' },
      legenda: { type: 'string', description: 'Opcional: legenda curta em português para a imagem' },
      fichas: { type: 'string', description: 'Fichas de personagem salvas que aparecem na imagem, separadas por vírgula (até 2), ex.: "nie-li"' },
      personagem: { type: 'string', description: 'Personagem existente, como "Nome (Obra)", ex.: "Ben Tennyson (Ben 10)": usa a ficha salva ou busca referências na internet e salva a ficha' },
      fase: { type: 'string', description: 'Fase do personagem quando ele muda com a idade/época/temporada, ex.: "criança", "adulto", "alien force"; cada fase tem a própria ficha' },
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
    private readonly deps: GenerateImageToolDeps = {},
  ) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const style = (args.estilo as string | undefined) ?? (args.imagem_base !== undefined ? 'ilustracao' : undefined);
    const baseImage = args.imagem_base !== undefined ? this.loadBase(Number(args.imagem_base), args.estilo as string | undefined) : undefined;
    const { sheets, created, references } = await this.resolveCharacters(args);

    // Aparência dos personagens (ficha) antes da cena; no modelo de anime, a tag do Danbooru vem primeiro.
    const anime = (style ?? '') === 'anime' || (style ?? '') === 'manga';
    // No anime, "1boy"/"1girl" (tags do Danbooru) seguram o gênero melhor que "male" no meio da descrição.
    const gender = (tags: string) => (/\b(female|girl|woman)\b/i.test(tags) ? '1girl' : /\b(male|boy|man)\b/i.test(tags) ? '1boy' : undefined);
    const appearance = sheets.map((s) => [...(anime && gender(s.tags) ? [gender(s.tags)!] : []), anime && s.danbooru ? s.danbooru : s.nome, s.tags].join(', '));
    // Um personagem: "solo" segura o modelo de repetir a figura (vício de quem desenha olhando uma referência).
    const description = [...(sheets.length === 1 ? ['solo'] : []), ...appearance, String(args.descricao)].join(', ');
    const image = await this.generator.generate({
      description,
      style,
      aspect: args.proporcao as string | undefined,
      seed: typeof args.seed === 'number' ? Math.trunc(args.seed) : undefined,
      ...(baseImage ? { baseImage, strength: (Object.keys(STRENGTHS).includes(String(args.intensidade)) ? args.intensidade : 'equilibrado') as Strength } : {}),
      ...(references.length ? { references, character: sheets.map((s) => s.nome).join(' e ') } : {}),
      // Com personagem, várias versões para a inspeção (anatomia + semelhança) escolher a melhor.
      candidates: sheets.length ? (this.deps.candidates ?? 3) : 1,
    });
    const userId = TaskContext.current()?.userId;
    if (userId) lastImages.set(userId, image.path);
    ResponseAttachments.addImage({ path: image.path, ...(typeof args.legenda === 'string' && args.legenda.trim() ? { caption: args.legenda.trim() } : {}) });
    return {
      output: JSON.stringify({
        ok: true,
        arquivo: path.basename(image.path),
        seed: image.seed,
        estilo: image.style,
        modelo: image.checkpoint,
        tamanho: `${image.width}x${image.height}`,
        segundos: Math.round(image.ms / 100) / 10,
        ...(sheets.length ? { fichas: sheets.map((s) => s.id + (s.fase ? ` (fase: ${s.fase})` : '')), imagens_de_referencia: references.reduce((n, r) => n + r.images.length, 0) } : {}),
        ...(created.length ? { fichas_criadas: created.map((s) => ({ ficha: s.id, fontes: s.fontes })), nota: 'Ficha salva: os próximos desenhos deste personagem usam a mesma referência (avise o usuário).' } : {}),
        ...(image.inspection ? { inspecao: image.inspection } : {}),
        ...(baseImage ? { a_partir_de: `anexo #${String(args.imagem_base)}`, intensidade: args.intensidade ?? 'equilibrado' } : {}),
        entrega: 'A imagem já será enviada ao usuário junto da sua resposta; não repita o caminho do arquivo.',
        ...(image.warning ? { aviso: image.warning } : {}),
      }),
    };
  }

  /**
   * Fichas pedidas + personagem existente: ficha salva da fase pedida ou busca na internet (que já cria a ficha).
   * Se o personagem tiver várias fases salvas e o pedido não disser qual, pergunta em vez de misturar.
   */
  private async resolveCharacters(args: Record<string, unknown>): Promise<{ sheets: CharacterSheet[]; created: CharacterSheet[]; references: CharacterImages[] }> {
    const store = this.deps.sheets;
    const sheets: CharacterSheet[] = [];
    const created: CharacterSheet[] = [];
    const references: CharacterImages[] = [];
    const use = (sheet: CharacterSheet) => {
      sheets.push(sheet);
      if (store && sheet.id) references.push({ images: store.images(sheet) });
    };
    const names = typeof args.fichas === 'string' ? args.fichas.split(',').map((n) => n.trim()).filter(Boolean) : [];
    for (const name of names) {
      const sheet = store?.get(name);
      if (!sheet) throw new ToolArgumentError(`Ficha "${name}" não existe. Fichas: ${store?.list().map((s) => s.id).join(', ') || '(nenhuma)'}. Crie com criar_ficha_personagem.`);
      use(sheet);
    }

    const character = typeof args.personagem === 'string' ? args.personagem.trim() : '';
    const phase = typeof args.fase === 'string' && args.fase.trim() ? args.fase.trim() : undefined;
    if (character) {
      const [nome, obra] = /^(.*?)\s*\((.*)\)\s*$/.exec(character)?.slice(1).map((s) => s.trim()) ?? [character];
      const phases = store?.phases(nome!) ?? [];
      const saved = phase ? store?.get(`${nome} ${phase}`) : phases.length === 1 ? phases[0] : undefined;
      if (!phase && phases.length > 1) {
        throw new ToolArgumentError(
          `"${nome}" tem ${phases.length} fases salvas: ${phases.map((s) => `${s.fase ?? '(sem fase)'} (ficha ${s.id})`).join(', ')}. Pergunte ao usuário qual fase usar e passe em "fase" (ou use "fichas").`,
        );
      }
      if (saved) {
        if (!sheets.some((s) => s.id === saved.id)) use(saved);
      } else {
        if (!this.deps.references) {
          throw new ToolArgumentError('Para desenhar um personagem existente preciso buscar referências na internet, mas o módulo "pesquisa-web" está desligado. Peça ao usuário para descrever a aparência (ou mandar uma imagem dele).');
        }
        const reference = await this.deps.references.find(character, phase);
        const fields = { nome: nome!, ...(obra ? { obra } : {}), ...(phase ? { fase: phase } : {}), tags: reference.tags, ...(reference.danbooru ? { danbooru: reference.danbooru } : {}) };
        if (store && reference.images.length) {
          const sheet = store.save({ ...fields, origem: 'internet', fontes: reference.sources }, reference.images);
          use(sheet);
          created.push(sheet);
        } else {
          // Sem onde guardar (ou sem imagem limpa): usa a referência só nesta imagem.
          sheets.push({ id: '', ...fields, origem: 'internet', criadaEm: '' });
          if (reference.images.length) {
            references.push({ images: reference.images.map((img, i) => ({ data: Buffer.from(img.base64, 'base64'), name: `referencia-${i + 1}.png`, mime: img.mime })) });
          }
        }
      }
    }
    return { sheets: sheets.slice(0, 2), created, references: references.slice(0, 2) };
  }

  /** Foto do usuário atual (anexos), só para estilos de desenho. */
  private loadBase(id: number, style: string | undefined): { data: Buffer; name: string } {
    if (!this.deps.attachments) throw new ToolArgumentError('Transformar foto exige o módulo "anexos" ligado.');
    if (style && !DRAWING_STYLES.includes(style)) {
      throw new ToolArgumentError(`Foto de base só vira desenho (${DRAWING_STYLES.join(', ')}); o estilo realista não é usado sobre fotos.`);
    }
    const userId = TaskContext.current()?.userId ?? '';
    const attachment = Number.isInteger(id) ? this.deps.attachments.store.get(userId, id) : undefined;
    if (!attachment) throw new ToolArgumentError(`Anexo #${String(id)} não encontrado (use listar_anexos).`);
    if (attachment.kind !== 'image') throw new ToolArgumentError(`O anexo #${id} não é uma imagem.`);
    return { data: this.deps.attachments.store.readFile(attachment), name: `base-${id}${path.extname(attachment.name) || '.jpg'}` };
  }
}

