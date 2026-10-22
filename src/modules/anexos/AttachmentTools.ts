import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import type { AttachmentService } from './AttachmentService.js';
import type { Attachment, AttachmentKind } from './AttachmentStore.js';

const KINDS: AttachmentKind[] = ['image', 'pdf', 'text'];

/** Usuário da requisição atual: cada um só enxerga os próprios anexos. */
function currentUser(): string {
  const userId = TaskContext.current()?.userId;
  if (!userId) throw new Error('Ferramenta de anexos fora de uma conversa');
  return userId;
}

function describe(a: Attachment): string {
  const size = a.kind === 'image' ? `${Math.round(a.sizeBytes / 1024)} KB` : `${a.extractedChars.toLocaleString('pt-BR')} caracteres`;
  return `#${a.id} · ${a.name} · ${a.kind} · ${size} · ${a.createdAt}${a.caption ? ` · legenda: "${a.caption.slice(0, 80)}"` : ''}`;
}

function find(service: AttachmentService, id: unknown): Attachment {
  const attachment = service.store.get(currentUser(), Number(id));
  if (!attachment) throw new ToolArgumentError(`Anexo #${String(id)} não encontrado (use listar_anexos)`);
  return attachment;
}

export class ListAttachmentsTool extends BaseTool {
  readonly name = 'listar_anexos';
  readonly description = 'Lista os anexos que o usuário já enviou (imagens, PDFs, textos), do mais recente ao mais antigo, com ID, tipo e data.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: KINDS, description: 'Filtra por tipo: image, pdf ou text' },
      nome: { type: 'string', description: 'Parte do nome do arquivo ou da legenda' },
      limite: { type: 'integer', description: 'Quantos (padrão 10, máximo 50)' },
    },
    additionalProperties: false,
  };

  constructor(private readonly service: AttachmentService) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = Math.min(50, Math.max(1, Number(args.limite) || 10));
    const items = this.service.store.list(currentUser(), { kind: args.tipo as AttachmentKind | undefined, name: args.nome as string | undefined, limit });
    return { output: items.length ? items.map(describe).join('\n') : 'Nenhum anexo encontrado.' };
  }
}

export class ReadAttachmentTool extends BaseTool {
  readonly name = 'ler_anexo';
  readonly description =
    'Lê o texto de um anexo pelo ID (documentos por página; imagens passam por OCR). Para documentos longos, use "inicio" para continuar de onde parou.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'ID do anexo (ex.: 12)' },
      inicio: { type: 'integer', description: 'Caractere inicial (padrão 0)' },
      max_caracteres: { type: 'integer', description: 'Quantos caracteres (padrão 12000)' },
    },
    required: ['id'],
    additionalProperties: false,
  };

  constructor(private readonly service: AttachmentService) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const attachment = find(this.service, args.id);
    const parts = await this.service.text(currentUser(), attachment);
    const full = parts.map((p) => (parts.length > 1 ? `[${p.label}]\n${p.text}` : p.text)).join('\n\n');
    if (!full.trim()) return { output: `Anexo #${attachment.id} (${attachment.name}) não tem texto extraível.` };
    const start = Math.max(0, Number(args.inicio) || 0);
    const max = Math.min(30_000, Math.max(500, Number(args.max_caracteres) || 12_000));
    const slice = full.slice(start, start + max);
    const more = start + max < full.length ? `\n[... continua: ler_anexo(${attachment.id}, inicio=${start + max}) de ${full.length} caracteres ...]` : '';
    return { output: `Anexo #${attachment.id} · ${attachment.name}\n${slice}${more}` };
  }
}

export class SearchAttachmentsTool extends BaseTool {
  readonly name = 'buscar_nos_anexos';
  readonly description = 'Procura palavras dentro do texto de todos os anexos do usuário e devolve os trechos encontrados com o ID do anexo.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { termo: { type: 'string', description: 'Palavras a procurar (ex.: "CNPJ", "prazo de entrega")' } },
    required: ['termo'],
    additionalProperties: false,
  };

  constructor(private readonly service: AttachmentService) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const hits = this.service.store.search(currentUser(), String(args.termo));
    if (!hits.length) return { output: `Nada encontrado para "${String(args.termo)}" (imagens só entram na busca depois de lidas com ler_anexo).` };
    return { output: hits.map((h) => `#${h.attachment.id} ${h.attachment.name} (${h.label}): ${h.snippet}`).join('\n') };
  }
}

export class AnalyzeImageTool extends BaseTool {
  readonly name = 'analisar_imagem';
  readonly description = 'Faz uma pergunta sobre uma imagem já guardada na biblioteca (ex.: "qual o total do recibo?"), usando um modelo com visão.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'ID do anexo de imagem' },
      pergunta: { type: 'string', description: 'O que você quer saber da imagem' },
    },
    required: ['id', 'pergunta'],
    additionalProperties: false,
  };

  constructor(private readonly service: AttachmentService) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const attachment = find(this.service, args.id);
    const answer = await this.service.analyzeImage(currentUser(), attachment, String(args.pergunta));
    return { output: `Anexo #${attachment.id} (${attachment.name}): ${answer}` };
  }
}

export function createAttachmentTools(service: AttachmentService): BaseTool[] {
  return [new ListAttachmentsTool(service), new ReadAttachmentTool(service), new SearchAttachmentsTool(service), new AnalyzeImageTool(service)];
}
