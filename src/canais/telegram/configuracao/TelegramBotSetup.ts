import fs from 'node:fs';
import { Api, InputFile } from 'grammy';
import type { BotCommand } from '../botCommands.js';

export interface BotInfo {
  id: number;
  username: string;
  nome: string;
  /** O bot pode criar e controlar outros bots (modo de gerenciar bots, ligado no @BotFather). */
  podeGerenciar: boolean;
}

/** Como o bot da fita aparece no Telegram (vem do perfil.yaml). */
export interface BotProfile {
  nome: string;
  /** Descrição longa: aparece na tela vazia do chat, antes do Iniciar (até 512 caracteres). */
  descricao: string;
  /** Descrição curta: aparece no perfil do bot e quando ele é compartilhado (até 120 caracteres). */
  curta: string;
  comandos: BotCommand[];
  /** Donos: veem também os comandos de acesso. */
  donos?: { ids: Iterable<number>; comandos: BotCommand[] };
  /** Foto do bot (JPG), se a fita tiver (`bot/foto.jpg`). */
  foto?: string;
}

export interface ManagedBot {
  token: string;
  bot: BotInfo;
  /** Quem confirmou a criação no Telegram. */
  criadoPor: { id: number; nome: string };
}

/** Username de bot: 5 a 32 caracteres, letras, números e _, terminando em "bot". */
export function suggestUsername(fita: string): string {
  const base = fita.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'fita';
  return /bot$/.test(base) ? base : `${base}_bot`;
}

/** Link que abre o Telegram já com o pedido de criar o bot (nome e @ preenchidos) pelo bot gerente. */
export function managedBotLink(managerUsername: string, suggestedUsername: string, name: string): string {
  return `https://t.me/newbot/${managerUsername.replace(/^@/, '')}/${suggestedUsername}?name=${encodeURIComponent(name)}`;
}

/**
 * Cria e configura o bot do Telegram de uma fita: confere o token, ajusta nome, descrições, menu de comandos e
 * foto a partir do perfil, e cria bots novos pelo bot "gerente" do K7 (bots gerenciados, Bot API 9.6), sem passar
 * pelo @BotFather a cada fita. Nunca registra tokens no log.
 */
export class TelegramBotSetup {
  constructor(private readonly options: { apiRoot?: string } = {}) {}

  private api(token: string): Api {
    return new Api(token, this.options.apiRoot ? { apiRoot: this.options.apiRoot } : undefined);
  }

  async info(token: string): Promise<BotInfo> {
    const me = await this.api(token).getMe();
    return { id: me.id, username: me.username, nome: me.first_name, podeGerenciar: (me as { can_manage_bots?: boolean }).can_manage_bots === true };
  }

  /** Aplica o perfil ao bot. Cada item é independente: um que falhar (ex.: foto) não impede os outros. */
  async configure(token: string, profile: BotProfile): Promise<{ feitos: string[]; falhas: string[] }> {
    const api = this.api(token);
    const feitos: string[] = [];
    const falhas: string[] = [];
    const step = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
        feitos.push(label);
      } catch (error) {
        falhas.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await step('nome', () => api.setMyName(profile.nome.slice(0, 64)));
    await step('descrição', () => api.setMyDescription(profile.descricao.slice(0, 512)));
    await step('descrição curta', () => api.setMyShortDescription(profile.curta.slice(0, 120)));
    await step('comandos', () => api.setMyCommands(profile.comandos));
    for (const owner of profile.donos?.ids ?? []) {
      await step(`comandos do dono ${owner}`, () => api.setMyCommands([...profile.donos!.comandos, ...profile.comandos], { scope: { type: 'chat', chat_id: owner } }));
    }
    if (profile.foto && fs.existsSync(profile.foto)) {
      await step('foto', () => api.setMyProfilePhoto({ type: 'static', photo: new InputFile(profile.foto!) }));
    }
    return { feitos, falhas };
  }

  /**
   * Espera o dono confirmar a criação do bot no Telegram (link de `managedBotLink`) e pega o token pelo gerente.
   * Só aceita bots criados por quem está em `owners`. O gerente não pode estar ligado em outro lugar ao mesmo tempo.
   */
  async waitManagedBot(managerToken: string, options: { owners: ReadonlySet<number>; timeoutMs: number; signal?: AbortSignal }): Promise<ManagedBot> {
    const api = this.api(managerToken);
    const deadline = Date.now() + options.timeoutMs;
    let offset: number | undefined;
    while (Date.now() < deadline && !options.signal?.aborted) {
      const wait = Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
      const updates = await api.getUpdates({ ...(offset !== undefined ? { offset } : {}), timeout: wait, allowed_updates: ['managed_bot'] as never });
      for (const update of updates) {
        offset = update.update_id + 1;
        const managed = (update as { managed_bot?: { user: { id: number; first_name: string }; bot: { id: number; username?: string; first_name: string } } }).managed_bot;
        if (!managed || (options.owners.size && !options.owners.has(managed.user.id))) continue;
        // Confirma o recebimento (o mesmo aviso não volta na próxima vez).
        await api.getUpdates({ offset, timeout: 0, allowed_updates: ['managed_bot'] as never }).catch(() => undefined);
        const token = await api.getManagedBotToken(managed.bot.id);
        return {
          token,
          bot: { id: managed.bot.id, username: managed.bot.username ?? '', nome: managed.bot.first_name, podeGerenciar: false },
          criadoPor: { id: managed.user.id, nome: managed.user.first_name },
        };
      }
    }
    throw new Error('O bot não foi criado a tempo: abra o link no Telegram e confirme a criação.');
  }

  /** Troca o token de um bot criado pelo gerente (ex.: vazou). O antigo para de funcionar na hora. */
  replaceManagedToken(managerToken: string, botId: number): Promise<string> {
    return this.api(managerToken).replaceManagedBotToken(botId);
  }
}

/**
 * Grava (ou troca) uma variável no `.env` da fita sem mexer nas outras linhas. Sem `.env`, começa pelo `.env.example`.
 * O valor nunca é mostrado: quem chama só informa que gravou.
 */
export function setEnvVariable(envFile: string, key: string, value: string, exampleFile?: string): void {
  const base = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : exampleFile && fs.existsSync(exampleFile) ? fs.readFileSync(exampleFile, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  const next = pattern.test(base) ? base.replace(pattern, () => line) : `${base}${base && !base.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(envFile, next, { mode: 0o600 });
}
