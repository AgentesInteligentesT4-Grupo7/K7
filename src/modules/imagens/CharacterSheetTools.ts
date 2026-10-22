import fs from 'node:fs';
import path from 'node:path';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { ImagePart, JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import type { AttachmentService } from '../anexos/AttachmentService.js';
import type { CharacterReferenceFinder } from './CharacterReference.js';
import type { CharacterSheets } from './CharacterSheets.js';
import { lastGeneratedImage } from './GenerateImageTool.js';

const ORIGINS = ['internet', 'anexo', 'ultima_imagem'] as const;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export interface SheetToolsDeps {
  sheets: CharacterSheets;
  references?: CharacterReferenceFinder;
  attachments?: AttachmentService;
}

/**
 * `criar_ficha_personagem`: a ficha guarda a imagem de referência + os traços do personagem, e todo desenho dele
 * passa a ser condicionado nela (mesmo rosto e corpo em todos os quadros da história).
 */
export class CreateCharacterSheetTool extends BaseTool {
  readonly name = 'criar_ficha_personagem';
  readonly description =
    'Cria (ou refaz) a ficha de um personagem para mantê-lo igual em todas as imagens da história. origem: "internet" (personagem que já ' +
    'existe: busca imagens de referência), "anexo" (imagem enviada pelo usuário, informe anexo_id) ou "ultima_imagem" (a última imagem ' +
    'gerada, quando o usuário aprovar o visual de um personagem original).';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string', description: 'Nome do personagem (vira o nome da ficha)' },
      obra: { type: 'string', description: 'Obra de origem (desenho, anime, livro...), se existir' },
      fase: { type: 'string', description: 'Fase do personagem (idade, época, temporada), ex.: "criança", "adulto", "alien force". Cada fase é uma ficha própria' },
      origem: { type: 'string', enum: [...ORIGINS], description: 'De onde vem a imagem de referência' },
      anexo_id: { type: 'integer', description: 'Com origem "anexo": ID da imagem enviada' },
      tracos: { type: 'string', description: 'Opcional: traços em inglês (cabelo, olhos, roupa, cores); sem isso, são lidos da imagem' },
    },
    required: ['nome', 'origem'],
    additionalProperties: false,
  };

  constructor(private readonly deps: SheetToolsDeps) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const nome = String(args.nome ?? '').trim();
    const obra = typeof args.obra === 'string' && args.obra.trim() ? args.obra.trim() : undefined;
    const origem = String(args.origem) as (typeof ORIGINS)[number];
    const fase = typeof args.fase === 'string' && args.fase.trim() ? args.fase.trim() : undefined;
    const label = obra ? `${nome} (${obra})` : nome;
    const { references } = this.deps;

    if (origem === 'internet') {
      if (!references) throw new ToolArgumentError('Buscar referências exige o módulo "pesquisa-web" ligado.');
      const found = await references.find(label, fase);
      if (!found.images.length) throw new ToolArgumentError(`Achei descrições de "${label}", mas nenhuma imagem de referência; peça uma imagem ao usuário (origem "anexo").`);
      const sheet = this.deps.sheets.save({ nome, ...(obra ? { obra } : {}), ...(fase ? { fase } : {}), tags: found.tags, ...(found.danbooru ? { danbooru: found.danbooru } : {}), origem: 'internet', fontes: found.sources }, found.images);
      return { output: JSON.stringify({ ok: true, ficha: sheet.id, imagens: Math.min(found.images.length, 4), tracos: sheet.tags, fontes: sheet.fontes, uso: `gerar_imagem com fichas="${sheet.id}"` }) };
    }

    const image = origem === 'anexo' ? this.fromAttachment(Number(args.anexo_id)) : this.fromLastImage();
    const traits = typeof args.tracos === 'string' && args.tracos.trim() ? { tags: args.tracos.trim() } : references ? await references.describeImage(label, image) : undefined;
    if (!traits) throw new ToolArgumentError('Informe os traços do personagem em "tracos" (cabelo, olhos, roupa, cores).');
    const sheet = this.deps.sheets.save({ nome, ...(obra ? { obra } : {}), ...(fase ? { fase } : {}), ...traits, origem: origem === 'anexo' ? 'anexo' : 'imagem-gerada' }, [image]);
    return { output: JSON.stringify({ ok: true, ficha: sheet.id, tracos: sheet.tags, uso: `gerar_imagem com fichas="${sheet.id}"` }) };
  }

  private fromAttachment(id: number): ImagePart {
    const { attachments } = this.deps;
    if (!attachments) throw new ToolArgumentError('Usar uma imagem enviada exige o módulo "anexos" ligado.');
    const attachment = Number.isInteger(id) ? attachments.store.get(TaskContext.current()?.userId ?? '', id) : undefined;
    if (!attachment || attachment.kind !== 'image') throw new ToolArgumentError(`Imagem #${String(id)} não encontrada (use listar_anexos).`);
    return { mime: attachment.mime || 'image/jpeg', base64: attachments.store.readFile(attachment).toString('base64') };
  }

  private fromLastImage(): ImagePart {
    const file = lastGeneratedImage(TaskContext.current()?.userId ?? '');
    if (!file || !fs.existsSync(file)) throw new ToolArgumentError('Ainda não gerei nenhuma imagem nesta conversa para virar ficha.');
    return { mime: MIME[path.extname(file).toLowerCase()] ?? 'image/png', base64: fs.readFileSync(file).toString('base64') };
  }
}

export class ListCharacterSheetsTool extends BaseTool {
  readonly name = 'listar_fichas';
  readonly description = 'Lista as fichas de personagem salvas (nome, obra, origem e traços), para usar em gerar_imagem com "fichas".';
  readonly parameters: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

  constructor(private readonly sheets: CharacterSheets) {
    super();
  }

  protected async run(): Promise<ToolResult> {
    const list = this.sheets.list();
    if (!list.length) return { output: 'Nenhuma ficha salva. Crie com criar_ficha_personagem (ou desenhe um personagem existente, que a ficha é criada sozinha).' };
    return { output: list.map((s) => `- ${s.id}: ${s.nome}${s.obra ? ` (${s.obra})` : ''}${s.fase ? ` · fase ${s.fase}` : ''} · origem ${s.origem} · ${s.tags.slice(0, 160)}`).join('\n') };
  }
}

export class DeleteCharacterSheetTool extends BaseTool {
  readonly name = 'apagar_ficha';
  readonly description = 'Apaga uma ficha de personagem (use quando o usuário não gostar da referência; depois crie outra).';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { nome: { type: 'string', description: 'Nome ou id da ficha' } },
    required: ['nome'],
    additionalProperties: false,
  };

  constructor(private readonly sheets: CharacterSheets) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.nome ?? '');
    if (!this.sheets.remove(name)) throw new ToolArgumentError(`Ficha "${name}" não existe.`);
    return { output: `Ficha "${name}" apagada.` };
  }
}
