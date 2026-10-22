import fs from 'node:fs';
import path from 'node:path';
import { TaskContext } from '../../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../../llm/types.js';
import { BaseTool, ToolArgumentError, type ToolResult } from '../../tools/BaseTool.js';
import type { AttachmentService } from '../anexos/AttachmentService.js';
import { type KnowledgeIndexer, baseName } from './KnowledgeIndexer.js';
import type { KnowledgeStore } from './KnowledgeStore.js';
import { type KnowledgeRetriever, formatRetrieval } from './KnowledgeRetriever.js';

export interface KnowledgeToolsDeps {
  store: KnowledgeStore;
  indexer: KnowledgeIndexer;
  retriever: KnowledgeRetriever;
  /** Pasta onde o que o usuário guarda pelo chat vira arquivo (fora da fita, nos dados do perfil). */
  userDir: string;
  attachments?: AttachmentService;
}

export class SearchKnowledgeTool extends BaseTool {
  readonly name = 'consultar_conhecimento';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      consulta: { type: 'string', description: 'Pergunta ou termos, de forma completa e independente da conversa (ex.: "prazo de troca de produtos com defeito")' },
      base: { type: 'string', description: 'Nome da base (opcional; sem ela, busca em todas)' },
    },
    required: ['consulta'],
    additionalProperties: false,
  };

  constructor(private readonly deps: KnowledgeToolsDeps) {
    super();
  }

  /** A descrição lista as bases do momento (relida a cada execução, como as skills). */
  get description(): string {
    const bases = this.deps.indexer.bases().filter((b) => b.documents > 0 || b.description);
    const list = bases.map((b) => `${b.name}${b.description ? ` (${b.description})` : ''}`).join('; ');
    return `Busca trechos na base de conhecimento desta fita (documentos próprios, não a internet). Use antes de responder sobre o conteúdo deles e cite como [n].${list ? ` Bases: ${list}.` : ''}`;
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args.consulta ?? '').trim();
    if (!query) throw new ToolArgumentError('Informe a consulta');
    const base = typeof args.base === 'string' && args.base.trim() ? baseName(args.base) : undefined;
    if (base && !this.deps.indexer.bases().some((b) => b.name === base)) {
      throw new ToolArgumentError(`Base "${base}" não existe. Bases: ${this.deps.indexer.bases().map((b) => b.name).join(', ') || '(nenhuma)'}`);
    }
    const result = await this.deps.retriever.retrieve(query, base ? { bases: [base] } : {});
    return { output: formatRetrieval(result) };
  }
}

export class ListKnowledgeTool extends BaseTool {
  readonly name = 'listar_conhecimento';
  readonly description = 'Lista as bases de conhecimento desta fita: nome, descrição, idioma e quantos documentos e trechos têm.';
  readonly parameters: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

  constructor(private readonly deps: KnowledgeToolsDeps) {
    super();
  }

  protected async run(): Promise<ToolResult> {
    await this.deps.indexer.sync();
    const bases = this.deps.indexer.bases();
    if (!bases.length) return { output: 'A base de conhecimento está vazia (ponha arquivos .md, .txt ou .pdf em conhecimento/ na fita, ou peça para guardar um texto).' };
    const stats = this.deps.store.stats();
    const vectors = Object.entries(stats.embedded).map(([model, n]) => `${n} com vetores (${model})`).join(', ') || 'busca só por palavras';
    const lines = bases.map((b) => `- ${b.name}: ${b.documents} documento(s)${b.description ? ` · ${b.description}` : ''}${b.language ? ` · ${b.language}` : ''}`);
    return { output: `${lines.join('\n')}\nTotal: ${stats.chunks} trechos; ${vectors}.` };
  }
}

export class SaveKnowledgeTool extends BaseTool {
  readonly name = 'guardar_no_conhecimento';
  readonly description =
    'Guarda um texto (ou um anexo já enviado) na base de conhecimento para consultas futuras. Use quando o usuário pedir para lembrar, arquivar ou "aprender" um conteúdo.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: {
      titulo: { type: 'string', description: 'Título curto (vira o nome do arquivo)' },
      texto: { type: 'string', description: 'Conteúdo a guardar (se não for um anexo)' },
      anexo_id: { type: 'integer', description: 'ID de um anexo já enviado (listar_anexos)' },
      base: { type: 'string', description: 'Base onde guardar (padrão: anotacoes)' },
    },
    required: ['titulo'],
    additionalProperties: false,
  };

  constructor(private readonly deps: KnowledgeToolsDeps) {
    super();
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const title = String(args.titulo ?? '').trim();
    if (!title) throw new ToolArgumentError('Informe o título');
    let content = typeof args.texto === 'string' ? args.texto.trim() : '';
    if (args.anexo_id !== undefined) {
      const { attachments } = this.deps;
      if (!attachments) throw new ToolArgumentError('O módulo anexos está desligado nesta fita');
      const userId = TaskContext.current()?.userId ?? '';
      const attachment = attachments.store.get(userId, Number(args.anexo_id));
      if (!attachment) throw new ToolArgumentError(`Anexo #${String(args.anexo_id)} não encontrado`);
      const parts = await attachments.text(userId, attachment);
      content = parts.map((p) => p.text).join('\n\n').trim();
    }
    if (!content) throw new ToolArgumentError('Informe "texto" ou "anexo_id"');
    const base = baseName(typeof args.base === 'string' && args.base.trim() ? args.base : 'anotacoes');
    const dir = path.join(this.deps.userDir, base);
    fs.mkdirSync(dir, { recursive: true });
    const slug = baseName(title).slice(0, 60);
    let file = path.join(dir, `${slug}.md`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${slug}-${n}.md`);
    fs.writeFileSync(file, `# ${title}\n\n${content}\n`);
    await this.deps.indexer.sync(true);
    return { output: `Guardado em ${base}/${path.basename(file)} (${content.length.toLocaleString('pt-BR')} caracteres). Já pode ser consultado.` };
  }
}
