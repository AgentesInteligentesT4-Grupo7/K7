import { type Bot, type Context, InlineKeyboard, InputFile, type NextFunction } from 'grammy';
import type { TelegramAccessMode } from '../../../config/Config.js';
import { Logger } from '../../../utils/Logger.js';
import { inviteLink, qrPng } from './convite.js';
import { type AccessEntry, type TelegramAccessStore, type TelegramPerson } from './TelegramAccessStore.js';

export interface AccessGateOptions {
  store: TelegramAccessStore;
  /** Donos do bot (TELEGRAM_ALLOWED_USER_IDS): sempre entram, recebem os pedidos e geram convites. */
  owners: ReadonlySet<number>;
  mode: TelegramAccessMode;
  /** Quem chega sem convite vira pedido para os donos aprovarem. */
  requests: boolean;
  /** Mensagens por hora de cada pessoa no modo `aberto`. */
  hourlyLimit: number;
  /** Nome do agente, nas mensagens para quem chega. */
  agentName: string;
}

const HOUR_MS = 3600_000;
/** Quem insiste sem acesso recebe o aviso no máximo a cada 10 min (o resto é ignorado, sem custo). */
const NOTICE_INTERVAL_MS = 10 * 60_000;

const REASONS: Record<string, string> = {
  invalido: 'esse convite não existe',
  expirado: 'esse convite venceu',
  esgotado: 'esse convite já foi usado',
  revogado: 'esse convite foi cancelado',
};

/**
 * Porteiro do bot da fita. Os donos sempre entram. No modo `lista` (padrão, como sempre foi), só eles.
 * No `convite`, entra quem abriu um link de convite (`/start <código>`) ou teve o pedido aprovado pelos donos (botões
 * Aprovar/Recusar no Telegram). No `aberto`, qualquer pessoa, com limite por hora. Bloqueados nunca passam.
 */
export class TelegramAccessGate {
  private readonly logger = new Logger('Acesso');
  private readonly lastNotice = new Map<number, number>();
  private readonly hits = new Map<number, number[]>();

  constructor(private readonly options: AccessGateOptions) {}

  get store(): TelegramAccessStore {
    return this.options.store;
  }

  /** Middleware de topo: nada passa daqui sem acesso (antes de banco, LLM ou extensão). */
  async check(ctx: Context, next: NextFunction): Promise<void> {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    if (this.options.owners.has(from.id)) return next();
    const { mode, store } = this.options;
    if (mode === 'lista') return void this.logger.debug(`Ignorado: ${from.id} fora da lista`);
    // Grupos e canais ficam de fora: o acesso é pessoal.
    if (ctx.chat && ctx.chat.type !== 'private') return;

    const person = personOf(ctx);
    let entry = store.get(from.id);
    if (entry?.status === 'bloqueado') return;

    const code = startCode(ctx);
    if (code && entry?.status !== 'ativo') {
      const result = store.redeem(code, person);
      if (result.ok) {
        this.logger.info(`🎟️ ${label(result.entry)} entrou por convite`);
        await this.notifyOwners(`🎟️ ${label(result.entry)} entrou pelo convite${result.entry.convite ? ` ${result.entry.convite.slice(0, 6)}…` : ''}.`);
        await ctx.reply(`✅ Acesso liberado! Bem-vindo(a) ao ${this.options.agentName}.`).catch(() => undefined);
        return next();
      }
      await ctx.reply(`⚠️ Não deu: ${REASONS[result.motivo]}.${mode === 'convite' && this.options.requests ? ' Vou pedir acesso para você.' : ''}`).catch(() => undefined);
      entry = store.get(from.id);
    }

    if (entry?.status === 'ativo') {
      if (mode === 'aberto' && !this.withinLimit(from.id)) {
        return this.noticeOnce(ctx, `⏳ Limite de ${this.options.hourlyLimit} mensagens por hora atingido; tente de novo mais tarde.`);
      }
      store.touch(from.id);
      return next();
    }

    if (mode === 'aberto') {
      store.save(person, 'ativo', 'aberto');
      this.withinLimit(from.id);
      return next();
    }

    // Modo convite, sem acesso ainda.
    if (!this.options.requests) return this.noticeOnce(ctx, `🔒 O ${this.options.agentName} é só para convidados. Peça um convite a quem cuida dele.`);
    if (!entry) {
      const saved = store.save(person, 'pendente', 'pedido');
      this.logger.info(`🙋 Pedido de acesso: ${label(saved)}`);
      await this.notifyOwners(`🙋 Pedido de acesso ao ${this.options.agentName}: ${label(saved)}`, decisionKeyboard(saved.userId));
      this.lastNotice.set(from.id, Date.now());
      return void (await ctx.reply('📨 Pedido de acesso enviado. Assim que for aprovado, eu aviso por aqui.').catch(() => undefined));
    }
    return this.noticeOnce(ctx, '⏳ Seu pedido de acesso ainda está esperando aprovação.');
  }

  /** Comandos e botões dos donos: /convite, /acessos e Aprovar/Recusar/Bloquear/Liberar. */
  register(bot: Bot): void {
    const ownersOnly = (ctx: Context) => ctx.from !== undefined && this.options.owners.has(ctx.from.id);

    bot.command('convite', async (ctx) => {
      if (!ownersOnly(ctx)) return;
      if (this.options.mode !== 'convite') {
        return void (await ctx.reply(
          `ℹ️ Este bot está no modo "${this.options.mode}". Para usar convites, ponha no perfil.yaml da fita:\ntelegram:\n  acesso: convite\ne reinicie o bot.`,
        ));
      }
      const nome = String(ctx.match ?? '').trim() || undefined;
      const invite = this.store.createInvite({ nome });
      const link = inviteLink(ctx.me.username, invite.codigo);
      const caption = `🎟️ Convite${nome ? ` para ${nome}` : ''} (uso único, vale até ${invite.expiraEm.slice(0, 10)}):\n${link}\n\nA pessoa escaneia o QR ou abre o link e toca em Iniciar.`;
      await ctx.replyWithPhoto(new InputFile(await qrPng(link), 'convite.png'), { caption });
    });

    bot.command('acessos', async (ctx) => {
      if (!ownersOnly(ctx)) return;
      const all = this.store.list();
      if (!all.length) return void (await ctx.reply(`Ninguém além dos donos tem acesso ainda (modo "${this.options.mode}"). Gere um convite com /convite <nome>.`));
      const icon = { ativo: '✅', pendente: '🙋', bloqueado: '⛔' } as const;
      await ctx.reply(
        `👥 Acessos (${all.length}), modo "${this.options.mode}":\n\n${all
          .slice(0, 40)
          .map((e) => `${icon[e.status]} ${label(e)} · ${e.origem}${e.ultimoContato ? ` · visto ${e.ultimoContato.slice(0, 16)}` : ''}`)
          .join('\n')}${all.length > 40 ? `\n… e mais ${all.length - 40}` : ''}`,
      );
      for (const pending of all.filter((e) => e.status === 'pendente').slice(0, 10)) {
        await ctx.reply(`🙋 Pedido: ${label(pending)}`, { reply_markup: decisionKeyboard(pending.userId) });
      }
    });

    bot.callbackQuery(/^acesso:(aprovar|recusar|bloquear|liberar):(\d+)$/, async (ctx) => {
      if (!ownersOnly(ctx)) return void (await ctx.answerCallbackQuery());
      const [, action, id] = ctx.match as RegExpMatchArray;
      const userId = Number(id);
      const entry = this.store.get(userId);
      if (!entry) return void (await ctx.answerCallbackQuery({ text: 'Essa pessoa não está mais na lista.' }));
      const approve = action === 'aprovar' || action === 'liberar';
      this.store.setStatus(userId, approve ? 'ativo' : 'bloqueado');
      const by = ctx.from.first_name;
      await ctx.answerCallbackQuery({ text: approve ? 'Liberado' : 'Bloqueado' });
      await ctx.editMessageText(`${approve ? '✅ Liberado' : '⛔ Recusado'} por ${by}: ${label(entry)}`).catch(() => undefined);
      await ctx.api
        .sendMessage(userId, approve ? `✅ Seu acesso ao ${this.options.agentName} foi liberado! Pode mandar sua mensagem.` : '⛔ Seu pedido de acesso não foi aprovado.')
        .catch(() => undefined);
      this.logger.info(`${approve ? '✅' : '⛔'} ${label(entry)} ${approve ? 'liberado' : 'bloqueado'} por ${by}`);
    });
  }

  /** Avisa todos os donos (quem nunca falou com o bot não recebe: o Telegram não deixa o bot começar a conversa). */
  private async notifyOwners(text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (!this.api) return;
    for (const owner of this.options.owners) {
      await this.api.sendMessage(owner, text, keyboard ? { reply_markup: keyboard } : {}).catch(() => undefined);
    }
  }

  private api?: Bot['api'];

  /** O porteiro precisa da API do bot para avisar os donos. */
  attach(bot: Bot): this {
    this.api = bot.api;
    return this;
  }

  private withinLimit(userId: number): boolean {
    const now = Date.now();
    const recent = (this.hits.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= this.options.hourlyLimit) return false;
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }

  private async noticeOnce(ctx: Context, text: string): Promise<void> {
    const userId = ctx.from!.id;
    const last = this.lastNotice.get(userId) ?? 0;
    if (Date.now() - last < NOTICE_INTERVAL_MS) return;
    this.lastNotice.set(userId, Date.now());
    await ctx.reply(text).catch(() => undefined);
  }
}

function decisionKeyboard(userId: number): InlineKeyboard {
  return new InlineKeyboard().text('✅ Aprovar', `acesso:aprovar:${userId}`).text('⛔ Recusar', `acesso:recusar:${userId}`);
}

function personOf(ctx: Context): TelegramPerson {
  const from = ctx.from!;
  return { id: from.id, nome: [from.first_name, from.last_name].filter(Boolean).join(' ') || String(from.id), ...(from.username ? { username: from.username } : {}) };
}

function label(entry: Pick<AccessEntry, 'nome' | 'username' | 'userId'>): string {
  return `${entry.nome}${entry.username ? ` (@${entry.username})` : ''} [${entry.userId}]`;
}

/** Código do convite em `/start <código>` (o Telegram manda assim quando a pessoa abre `t.me/<bot>?start=<código>`). */
function startCode(ctx: Context): string | undefined {
  const text = ctx.message?.text ?? '';
  const match = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(text);
  return match?.[1];
}
