import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProgressBoard } from '../agent/ProgressBoard.js';
import { ResponseAttachments } from '../agent/ResponseAttachments.js';
import type { Config } from '../config/Config.js';
import { UserFacingError, errorMessage } from '../errors/AppErrors.js';
import { TaskContext } from '../llm/orchestration/TaskContext.js';
import type { JsonSchema } from '../llm/types.js';
import { BaseTool, type ToolResult } from '../tools/BaseTool.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { KeyedLimiter, mapWithLimit } from '../utils/KeyedLimiter.js';
import { Logger } from '../utils/Logger.js';
import type { FitaApi, FitaTool, WebRotaCtx } from './FitaApi.js';

export interface ExtensionRoute {
  method: 'GET' | 'POST' | 'DELETE';
  path: RegExp;
  visitor: boolean;
  handler: (ctx: WebRotaCtx) => Promise<void> | void;
}

export interface ExtensionCommand {
  name: string;
  description: string;
  run: (args: string[]) => Promise<void>;
}

/**
 * Erro de uma extensão para a pessoa ver: qualquer erro com `userMessage` em texto (a fita não importa as
 * classes do tocador) vira UserFacingError; os demais seguem como estão.
 */
export function fromExtension(error: unknown): unknown {
  if (error instanceof UserFacingError || !(error instanceof Error)) return error;
  const message = (error as { userMessage?: unknown }).userMessage;
  return typeof message === 'string' ? new UserFacingError(message, error.message, { cause: error }) : error;
}

/** Ferramenta de uma fita, adaptada ao ciclo do agente (quem pediu, andamento, mídia na resposta). */
class ExtensionTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;

  constructor(private readonly tool: FitaTool) {
    super();
    this.name = tool.name;
    this.description = tool.description;
    this.parameters = tool.parameters as JsonSchema;
  }

  protected async run(args: Record<string, unknown>): Promise<ToolResult> {
    const userId = TaskContext.current()?.userId;
    try {
      const output = await this.tool.run(args, {
        ...(userId ? { userId } : {}),
        progresso: (texto, contagem) => userId && ProgressBoard.set(userId, texto, contagem),
        limparProgresso: () => userId && ProgressBoard.clear(userId),
        anexarMidia: (caminho, tipo) => ResponseAttachments.addMedia({ path: caminho, kind: tipo }),
      });
      return { output };
    } catch (error) {
      throw fromExtension(error);
    } finally {
      if (userId) ProgressBoard.clear(userId);
    }
  }
}

/**
 * Extensão de uma fita (`extensao:` no perfil.yaml): o código da fita, carregado com o tocador. Ela registra
 * ferramentas para o agente, rotas e um painel na página web, comandos de terminal e verificações de início.
 * Quem instala uma fita com extensão confirma antes (o código roda com o mesmo acesso do tocador).
 */
export class ExtensionHost {
  readonly routes: ExtensionRoute[] = [];
  readonly commands: ExtensionCommand[] = [];
  panel?: { script?: string; style?: string };
  private readonly startHooks: Array<() => Promise<void> | void> = [];
  private readonly toolNames: string[] = [];
  private readonly logger: Logger;

  constructor(
    private readonly config: Config,
    private readonly registry: ToolRegistry,
  ) {
    this.logger = new Logger(`fita:${config.profileName ?? '?'}`);
  }

  get enabled(): boolean {
    return Boolean(this.config.extensionPath);
  }

  /** Carrega a extensão (TypeScript ou JavaScript) e chama `ativar(k7)`. */
  async load(): Promise<void> {
    const file = this.config.extensionPath;
    if (!file) return;
    if (!fs.existsSync(file)) throw new Error(`Extensão da fita não encontrada: ${file}`);
    const mod = (/\.[mc]?ts$/.test(file)
      ? await (await import('tsx/esm/api')).tsImport(pathToFileURL(file).href, import.meta.url)
      : await import(pathToFileURL(file).href)) as { default?: (k7: FitaApi) => unknown };
    // Fita sem package.json: o tsx carrega o .ts como CommonJS e o `export default` chega como default.default.
    const exported = mod.default as unknown;
    const activate = (typeof exported === 'function' ? exported : (exported as { default?: unknown } | undefined)?.default) as ((k7: FitaApi) => unknown) | undefined;
    if (typeof activate !== 'function') throw new Error(`A extensão ${path.basename(file)} precisa de "export default function ativar(k7)"`);
    await activate(this.api());
    this.logger.info(`🧩 Extensão da fita carregada: ${this.toolNames.join(', ') || 'sem ferramentas'}${this.routes.length ? ` · ${this.routes.length} rota(s) web` : ''}`);
  }

  /** Verificações de início da fita (serviço no ar etc.): falha vira aviso, não derruba o tocador. */
  async start(): Promise<void> {
    for (const hook of this.startHooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.warn(`⚠️ ${errorMessage(error)}`);
      }
    }
  }

  private api(): FitaApi {
    const { config } = this;
    const env = { ...process.env, ...config.env };
    return {
      fita: {
        nome: config.profileName ?? '',
        dir: config.profileDir ?? '',
        workspaceDir: config.workspaceDir,
        dadosDir: path.dirname(config.dbPath),
        env,
      },
      log: {
        info: (msg) => this.logger.info(msg),
        aviso: (msg) => this.logger.warn(msg),
        erro: (msg) => this.logger.error(msg),
      },
      ferramenta: (tool) => {
        this.registry.register(new ExtensionTool(tool));
        this.toolNames.push(tool.name);
      },
      web: {
        rota: (method, caminho, handler, opcoes = {}) => {
          if (!caminho.source.startsWith('^\\/api\\/x\\/')) throw new Error(`Rota de extensão precisa começar com /api/x/ (${caminho.source})`);
          this.routes.push({ method, path: caminho, visitor: opcoes.visitante !== false, handler });
        },
        painel: (arquivos) => {
          const inside = (rel?: string) => {
            if (!rel) return undefined;
            const full = path.resolve(config.profileDir ?? '', rel);
            if (!full.startsWith(path.resolve(config.profileDir ?? '') + path.sep)) throw new Error(`Arquivo do painel fora da fita: ${rel}`);
            return full;
          };
          this.panel = { script: inside(arquivos.script), style: inside(arquivos.estilo) };
        },
      },
      comando: (name, description, run) => this.commands.push({ name, description, run }),
      aoIniciar: (fn) => this.startHooks.push(fn),
      util: {
        limitador: (max) => new KeyedLimiter(max),
        emParalelo: (itens, max, tarefa) => mapWithLimit(itens, max, tarefa),
      },
    };
  }
}
