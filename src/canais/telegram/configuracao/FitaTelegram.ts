import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../../config/Config.js';
import { UserFacingError } from '../../../errors/AppErrors.js';
import { DatabaseConnection } from '../../../memory/DatabaseConnection.js';
import { loadConfig, readManifest } from '../../../profiles/ProfileLoader.js';
import { inviteLink, qrPng } from '../acesso/convite.js';
import { type AccessEntry, type AccessStatus, type Invite, TelegramAccessStore } from '../acesso/TelegramAccessStore.js';
import { botProfileFor } from './perfilDoBot.js';
import { type BotInfo, type ManagedBot, TelegramBotSetup, managedBotLink, setEnvVariable } from './TelegramBotSetup.js';

export interface AccessOverview {
  modo: Config['telegramAccess']['mode'];
  pedidos: boolean;
  donos: number[];
  pessoas: AccessEntry[];
  convites: Invite[];
}

/**
 * O Telegram de uma fita, fora do bot: conectar o bot (token ou bot gerente), aplicar nome/descrição/comandos/foto,
 * gerar convites com QR e cuidar de quem tem acesso. Usado pelo terminal (`npm run perfil`) e pela página de
 * administração. Lê o banco da fita com uma conexão própria (o bot pode estar rodando ao mesmo tempo).
 */
export class FitaTelegram {
  private readonly setup: TelegramBotSetup;

  constructor(
    readonly fita: string,
    private readonly options: { rootDir?: string; env?: NodeJS.ProcessEnv; setup?: TelegramBotSetup } = {},
  ) {
    // TELEGRAM_API_ROOT e TELEGRAM_PAGINA_ROOT: outro endereço para a API e para as páginas t.me (testes).
    const env = options.env ?? {};
    this.setup = options.setup ?? new TelegramBotSetup({ ...(env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : {}), ...(env.TELEGRAM_PAGINA_ROOT ? { paginaRoot: env.TELEGRAM_PAGINA_ROOT } : {}) });
  }

  /** Config da fita, relida a cada uso (o .env pode ter acabado de mudar). */
  config(): Config {
    return loadConfig({ argv: ['--perfil', this.fita], requireTelegram: false, ...(this.options.env ? { env: this.options.env } : {}), ...(this.options.rootDir ? { rootDir: this.options.rootDir } : {}) });
  }

  private withStore<T>(run: (store: TelegramAccessStore) => T): T {
    const db = DatabaseConnection.open(this.config().dbPath);
    try {
      return run(new TelegramAccessStore(db));
    } finally {
      db.close();
    }
  }

  /** Bot conectado à fita (pelo token do .env dela); `undefined` se ainda não tem token. */
  async bot(): Promise<BotInfo | undefined> {
    const token = this.config().telegramBotToken;
    return token ? this.setup.info(token) : undefined;
  }

  overview(): AccessOverview {
    const { telegramAccess, allowedUserIds } = this.config();
    return this.withStore((store) => ({
      modo: telegramAccess.mode,
      pedidos: telegramAccess.requests,
      donos: [...allowedUserIds],
      pessoas: store.list(),
      convites: store.listInvites(),
    }));
  }

  setStatus(userId: number, status: AccessStatus): AccessEntry | undefined {
    return this.withStore((store) => store.setStatus(userId, status));
  }

  removePerson(userId: number): boolean {
    return this.withStore((store) => store.remove(userId));
  }

  revokeInvite(codigo: string): boolean {
    return this.withStore((store) => store.revokeInvite(codigo));
  }

  /** Novo convite com link e QR (PNG). Avisa se a fita ainda não está no modo convite. */
  async invite(options: { nome?: string; dias?: number; usos?: number } = {}): Promise<{ invite: Invite; link: string; png: Buffer; aviso?: string }> {
    const bot = await this.bot();
    if (!bot) throw new UserFacingError(`a fita ${this.fita} ainda não tem bot: conecte um antes (npm run perfil -- bot ${this.fita})`);
    const invite = this.withStore((store) => store.createInvite(options));
    const link = inviteLink(bot.username, invite.codigo);
    const mode = this.config().telegramAccess.mode;
    return {
      invite,
      link,
      png: await qrPng(link),
      ...(mode !== 'convite' ? { aviso: `A fita está no modo "${mode}": o convite só vale depois de pôr "telegram: { acesso: convite }" no perfil.yaml e reiniciar o bot.` } : {}),
    };
  }

  /** Conecta um bot pelo token (do @BotFather ou do gerente): confere, grava no .env da fita e aplica o perfil. */
  async connectToken(token: string): Promise<{ bot: BotInfo; feitos: string[]; falhas: string[] }> {
    const bot = await this.setup.info(token.trim());
    const dir = this.config().profileDir!;
    setEnvVariable(path.join(dir, '.env'), 'TELEGRAM_BOT_TOKEN', token.trim(), path.join(dir, '.env.example'));
    return { bot, ...(await this.sync()) };
  }

  /** Reaplica nome, descrições, comandos e foto a partir do perfil (depois de mudar o perfil.yaml ou a foto). */
  async sync(): Promise<{ feitos: string[]; falhas: string[] }> {
    const config = this.config();
    if (!config.telegramBotToken) throw new UserFacingError(`a fita ${this.fita} não tem TELEGRAM_BOT_TOKEN`);
    const descricao = config.profileDir ? readManifest(config.profileDir).descricao : '';
    const nome = config.env.TELEGRAM_BOT_NOME?.trim();
    return this.setup.configure(config.telegramBotToken, { ...botProfileFor(config, descricao), ...(nome ? { nome } : {}) });
  }

  /** Link (e QR) para criar o bot da fita pelo gerente; o dono abre no Telegram e confirma. */
  /**
   * `nome` = o nome do bot (padrão: o da fita); o @ é o primeiro livre entre as variações dele, pulando `excluir`
   * (os que o Telegram já recusou).
   */
  async managedLink(managerToken: string, opcoes: { nome?: string; excluir?: string[] } = {}): Promise<{ link: string; png: Buffer; gerente: BotInfo; sugestao: string; ocupados: string[]; nome: string }> {
    const gerente = await this.setup.info(managerToken);
    if (!gerente.podeGerenciar) {
      throw new UserFacingError(`o bot @${gerente.username} ainda não pode criar bots: ligue o modo de gerenciar bots dele no @BotFather (Mini App)`);
    }
    const nome = opcoes.nome?.trim().slice(0, 64) || this.config().identity.name;
    const { username: sugestao, ocupados } = await this.setup.escolherUsername(nome, new Set(opcoes.excluir ?? []));
    const link = managedBotLink(gerente.username, sugestao, nome);
    return { link, png: await qrPng(link), gerente, sugestao, ocupados, nome };
  }

  /**
   * Espera o dono confirmar a criação, grava o token (e, se a fita não tiver donos, quem confirmou) e aplica o perfil.
   * `owners` vazio aceita o primeiro bot criado pelo gerente nesse intervalo.
   */
  async completeManaged(managerToken: string, timeoutMs: number, signal?: AbortSignal, nome?: string): Promise<ManagedBot & { feitos: string[]; falhas: string[] }> {
    const config = this.config();
    const created = await this.setup.waitManagedBot(managerToken, { owners: config.allowedUserIds, timeoutMs, ...(signal ? { signal } : {}) });
    const dir = config.profileDir!;
    const envFile = path.join(dir, '.env');
    setEnvVariable(envFile, 'TELEGRAM_BOT_TOKEN', created.token, path.join(dir, '.env.example'));
    if (!config.allowedUserIds.size) setEnvVariable(envFile, 'TELEGRAM_ALLOWED_USER_IDS', String(created.criadoPor.id));
    // O nome escolhido na criação continua valendo quando o perfil é reaplicado.
    if (nome?.trim() && nome.trim() !== config.identity.name) setEnvVariable(envFile, 'TELEGRAM_BOT_NOME', nome.trim().slice(0, 64));
    return { ...created, ...(await this.sync()) };
  }

  /** Onde guardar o PNG de um convite (pasta de dados da fita). */
  invitePngPath(codigo: string): string {
    const dir = path.join(path.dirname(this.config().dbPath), 'convites');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${codigo}.png`);
  }
}
