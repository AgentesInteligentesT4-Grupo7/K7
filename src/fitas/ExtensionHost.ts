import fs from 'node:fs';
import { load as parseYaml } from 'js-yaml';
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
import { htmlParaPng } from '../utils/HtmlParaPng.js';
import { KeyedLimiter, mapWithLimit } from '../utils/KeyedLimiter.js';
import { Logger } from '../utils/Logger.js';
import type { FitaApi, FitaSql, FitaTool, WebRotaCtx } from './FitaApi.js';
import { ExtensionTelegram } from './ExtensionTelegram.js';
import { DatabaseConnection, type SqliteDatabase } from '../memory/DatabaseConnection.js';
import { inviteLink, qrPng } from '../canais/telegram/acesso/convite.js';
import { TelegramAccessStore } from '../canais/telegram/acesso/TelegramAccessStore.js';

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

  constructor(
    private readonly tool: FitaTool,
    /** Pasta das imagens que a ferramenta anexa à resposta (workspace/imagens/fitas). */
    private readonly imagensDir: string,
  ) {
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
        anexarImagem: (png, legenda) => ResponseAttachments.addImage({ path: this.salvarImagem(png), ...(legenda?.trim() ? { caption: legenda.trim() } : {}) }),
      });
      return { output };
    } catch (error) {
      throw fromExtension(error);
    } finally {
      if (userId) ProgressBoard.clear(userId);
    }
  }

  /** Grava o PNG para o canal entregar; guarda só as 50 imagens mais recentes. */
  private salvarImagem(png: Buffer): string {
    fs.mkdirSync(this.imagensDir, { recursive: true });
    const file = path.join(this.imagensDir, `${Date.now()}-${this.name}-${Math.random().toString(36).slice(2, 8)}.png`);
    fs.writeFileSync(file, png);
    const antigas = fs.readdirSync(this.imagensDir).filter((f) => f.endsWith('.png')).sort().slice(0, -50);
    for (const f of antigas) fs.rmSync(path.join(this.imagensDir, f), { force: true });
    return file;
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
  panel?: { script?: string; style?: string; images?: string[]; frames?: string[] };
  private readonly startHooks: Array<() => Promise<void> | void> = [];
  private readonly toolNames: string[] = [];
  private readonly logger: Logger;
  private readonly tasks: Array<{ nome: string; ms: number; run: () => Promise<void> | void }> = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private db?: SqliteDatabase;
  /** O que a fita registra no bot do Telegram; o canal Telegram liga ao bot. */
  readonly telegram: ExtensionTelegram;

  constructor(
    private readonly config: Config,
    private readonly registry: ToolRegistry,
    /** `principal`: processo do bot, o único que roda as tarefas periódicas da fita. */
    private readonly options: { principal?: boolean } = {},
  ) {
    this.logger = new Logger(`fita:${config.profileName ?? '?'}`);
    this.telegram = new ExtensionTelegram(this.logger);
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

  /** Verificações de início da fita (serviço no ar etc.) e, no processo principal, as tarefas periódicas. */
  async start(): Promise<void> {
    for (const hook of this.startHooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.warn(`⚠️ ${errorMessage(error)}`);
      }
    }
    if (!this.options.principal) return;
    for (const task of this.tasks) {
      let running = false;
      const tick = async () => {
        if (running) return; // a anterior ainda não terminou: pula esta vez
        running = true;
        try {
          await task.run();
        } catch (error) {
          this.logger.warn(`⚠️ Tarefa "${task.nome}": ${errorMessage(error)}`);
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void tick(), task.ms);
      timer.unref();
      this.timers.push(timer);
      void tick();
    }
    if (this.tasks.length) this.logger.info(`⏰ Tarefas da fita: ${this.tasks.map((t) => `${t.nome} (${Math.round(t.ms / 60_000)} min)`).join(', ')}`);
  }

  /** Para as tarefas e fecha o banco da fita. */
  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    if (this.db?.open) this.db.close();
    this.db = undefined;
  }

  private sql(): FitaSql {
    const open = () => (this.db ??= DatabaseConnection.open(path.join(path.dirname(this.config.dbPath), `${this.config.profileName ?? 'fita'}.db`)));
    return {
      exec: (sql) => void open().exec(sql),
      run: (sql, ...params) => {
        const r = open().prepare(sql).run(...params);
        return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
      },
      get: (sql, ...params) => open().prepare(sql).get(...params) as never,
      all: (sql, ...params) => open().prepare(sql).all(...params) as never,
      transacao: (fn) => open().transaction(fn)(),
    };
  }

  private accessStore(): TelegramAccessStore {
    return new TelegramAccessStore(DatabaseConnection.getInstance(this.config.dbPath));
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
        this.registry.register(new ExtensionTool(tool, path.join(config.workspaceDir, 'imagens', 'fitas')));
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
          // Só origens https (sem caminho nem curinga): entram na política de segurança da página.
          const origins = (list?: string[]) =>
            (list ?? []).map((origin) => {
              if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(origin)) throw new Error(`Endereço do painel inválido (só https://dominio): ${origin}`);
              return origin.toLowerCase();
            });
          this.panel = { script: inside(arquivos.script), style: inside(arquivos.estilo), images: origins(arquivos.imagens), frames: origins(arquivos.quadros) };
        },
      },
      comando: (name, description, run) => this.commands.push({ name, description, run }),
      aoIniciar: (fn) => this.startHooks.push(fn),
      util: {
        limitador: (max) => new KeyedLimiter(max),
        emParalelo: (itens, max, tarefa) => mapWithLimit(itens, max, tarefa),
        lerYaml: (texto) => parseYaml(texto),
        svgParaPng: (svg, opcoes) => svgToPng(svg, opcoes?.largura),
        htmlParaPng: (html, opcoes) => htmlParaPng.render(html, opcoes),
      },
      processoPrincipal: this.options.principal === true,
      tarefa: (nome, intervaloMs, executar) => {
        if (!(intervaloMs >= 60_000)) throw new Error(`Tarefa "${nome}": intervalo mínimo de 1 minuto`);
        this.tasks.push({ nome, ms: intervaloMs, run: executar });
      },
      sql: this.sql(),
      telegram: {
        comando: (nome, descricao, executar) => this.telegram.addCommand(nome, descricao, executar),
        aoLocalizacao: (executar) => this.telegram.addLocation(executar),
        botoes: (prefixo, executar) => this.telegram.addButtons(prefixo, executar),
        notificar: (userId, mensagem) => this.telegram.notify(userId, mensagem),
        acessos: {
          listar: () => this.accessStore().list(),
          definir: (userId, status) => Boolean(this.accessStore().setStatus(userId, status)),
          convite: async (opcoes = {}) => {
            const username = await this.telegram.botUsername();
            const invite = this.accessStore().createInvite(opcoes);
            const link = inviteLink(username, invite.codigo);
            return { codigo: invite.codigo, link, png: await qrPng(link), expiraEm: invite.expiraEm };
          },
        },
      },
    };
  }
}

let resvg: Promise<typeof import('@resvg/resvg-js')> | undefined;

/** SVG → PNG com o resvg (sem navegador), usando as fontes instaladas no sistema. */
async function svgToPng(svg: string, largura?: number): Promise<Buffer> {
  const { Resvg } = await (resvg ??= import('@resvg/resvg-js'));
  const render = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
    ...(largura ? { fitTo: { mode: 'width' as const, value: largura } } : {}),
  }).render();
  return Buffer.from(render.asPng());
}
