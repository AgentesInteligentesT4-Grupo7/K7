import type { IContextProvider } from '../../agent/types.js';
import type { Config } from '../../config/Config.js';
import type { ILlmProvider } from '../../llm/types.js';
import type { SqliteDatabase } from '../../memory/DatabaseConnection.js';
import type { BaseTool } from '../../tools/BaseTool.js';
import { Logger } from '../../utils/Logger.js';
import type { ProcessRunner } from '../../utils/ProcessRunner.js';
import type { AttachmentService } from '../anexos/AttachmentService.js';
import { GeminiEmbeddings, type IEmbeddings, OllamaEmbeddings, selectEmbeddings } from './Embeddings.js';
import { KnowledgeIndexer } from './KnowledgeIndexer.js';
import { KnowledgeRetriever, formatRetrieval } from './KnowledgeRetriever.js';
import { KnowledgeStore } from './KnowledgeStore.js';
import { ListKnowledgeTool, SaveKnowledgeTool, SearchKnowledgeTool } from './KnowledgeTools.js';

const logger = new Logger('Conhecimento');

export interface KnowledgeModule {
  tools: BaseTool[];
  indexer: KnowledgeIndexer;
  retriever: KnowledgeRetriever;
  /** Modo automático: trechos relevantes entram no prompt de toda mensagem. */
  contextProvider?: IContextProvider;
}

export function createKnowledge(
  config: Config,
  deps: { db: SqliteDatabase; llm: ILlmProvider; runner: ProcessRunner; attachments?: AttachmentService; webSearch?: (q: string) => Promise<string> },
): KnowledgeModule {
  const options = config.knowledge;
  const ollamaRoot = config.providers.ollama.baseUrl?.replace(/\/v1$/, '') ?? 'http://localhost:11434';
  // Gemini recebe o texto dos documentos: só com privacidade "publico".
  const geminiAllowed = config.orchestrator.privacyDefault === 'publico';
  const geminiKey = config.providers.gemini.apiKey;
  if (options.embeddings === 'gemini' && !geminiAllowed) logger.warn('Embeddings do Gemini ignorados: a privacidade desta fita não é "publico"');

  let chosen: Promise<IEmbeddings | undefined> | undefined;
  const embeddings = () =>
    (chosen ??= selectEmbeddings({
      choice: options.embeddings,
      ollama: new OllamaEmbeddings(ollamaRoot, options.ollamaModel),
      ...(geminiKey && geminiAllowed ? { gemini: new GeminiEmbeddings(geminiKey, options.geminiModel) } : {}),
      hasGpu: async () => {
        try {
          await deps.runner.run('nvidia-smi', ['-L'], 5_000);
          return true;
        } catch {
          return false;
        }
      },
    }).then((provider) => {
      logger.info(provider ? `🧭 Embeddings: ${provider.name} (${provider.model})` : '🧭 Embeddings desligados: busca só por palavras (FTS5)');
      return provider;
    }));

  const store = new KnowledgeStore(deps.db);
  const indexer = new KnowledgeIndexer(store, [{ label: 'fita', dir: options.dir }, { label: 'usuario', dir: options.userDir }], {
    chunk: { size: options.chunkSize, overlap: options.chunkOverlap },
    embeddings,
  });
  const retriever = new KnowledgeRetriever(store, indexer, options.retrieval, { llm: deps.llm, embeddings, webSearch: deps.webSearch });
  const toolDeps = { store, indexer, retriever, userDir: options.userDir, attachments: deps.attachments };
  // Indexa em segundo plano no startup; a primeira busca espera se ainda estiver rodando.
  void indexer.sync(true).catch((error: unknown) => logger.warn(`Falha ao indexar: ${String(error)}`));

  return {
    tools: [new SearchKnowledgeTool(toolDeps), new ListKnowledgeTool(toolDeps), new SaveKnowledgeTool(toolDeps)],
    indexer,
    retriever,
    ...(options.auto
      ? {
          contextProvider: {
            async contextFor(text: string): Promise<string | undefined> {
              const result = await retriever.retrieve(text, { allowDirect: true });
              if (result.route === 'direta' || (!result.chunks.length && !result.web)) return undefined;
              return `# Conhecimento da fita (recuperado para esta mensagem)\nUse estes trechos se ajudarem a responder; se não ajudarem, ignore-os.\n${formatRetrieval(result)}`;
            },
          },
        }
      : {}),
  };
}
