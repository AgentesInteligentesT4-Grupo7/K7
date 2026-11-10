import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrDataUrl } from '../telegram/acesso/convite.js';
import type { AccessStatus } from '../telegram/acesso/TelegramAccessStore.js';
import { FitaTelegram } from '../telegram/configuracao/FitaTelegram.js';
import { TelegramBotSetup } from '../telegram/configuracao/TelegramBotSetup.js';
import { disabledExtension, editManifest, type ManifestChanges } from '../../profiles/ManifestEditor.js';
import { type CodeConfirmation, ProfileInstaller, inspectProfile } from '../../profiles/ProfileInstaller.js';
import { listProfiles, playerVersion, profileDirs } from '../../profiles/ProfileLoader.js';
import { PROFILE_NAME_PATTERN, ProfileError } from '../../profiles/ProfileManifest.js';
import { createProfile } from '../../profiles/ProfileTemplate.js';
import { CHANNELS, type ChannelId } from '../../modules/registry.js';
import { TELEGRAM_ACCESS_MODES, type TelegramAccessMode } from '../../config/Config.js';
import { UserFacingError } from '../../errors/AppErrors.js';
import { GrammyError } from 'grammy';
import { Logger } from '../../utils/Logger.js';
import type { AcessoCloudflare, Papel, PessoasDaAdmin } from './AdminPessoas.js';
import { FitaRunner } from './FitaRunner.js';
import { FitaServices } from './FitaServices.js';

const PAGE = fileURLToPath(new URL('../../../web/admin.html', import.meta.url));

export interface AdminServerOptions {
  port: number;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  /** Fixo (ADMIN_TOKEN) ou gerado a cada início. */
  token?: string;
  /** Onde escuta (padrão 127.0.0.1). No Docker, 0.0.0.0 dentro do container; a porta só sai para o 127.0.0.1 do PC e o túnel. */
  host?: string;
  /**
   * Domínios públicos aceitos além do 127.0.0.1 (ex.: admin.exemplo.com.br), sempre atrás do Cloudflare Access: o
   * pedido que chega por eles sem o cabeçalho do Access é recusado (Access desligado não abre a página para todos).
   */
  dominios?: string[];
  /** Pelo domínio público: confere o login do Access e dá o papel de cada e-mail (aba Pessoas). */
  acesso?: AcessoCloudflare;
  pessoas?: PessoasDaAdmin;
  runner?: FitaRunner;
  services?: FitaServices;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface ManagedJob {
  estado: 'esperando' | 'pronto' | 'erro';
  link: string;
  qr: string;
  /** Nome do bot e o @ sugerido; os @ já tentados (para "tentar outro") e os que estavam ocupados. */
  nome: string;
  sugestao: string;
  tentados: string[];
  ocupados: string[];
  bot?: string;
  erro?: string;
  abort: AbortController;
}

/**
 * Página de administração das fitas (`npm run admin`), **só no próprio computador** (127.0.0.1, token no endereço,
 * Host conferido). Lista as fitas e liga/desliga cada parte sem editar arquivo nem usar o terminal: a fita rodando,
 * canais, vitrine, extensão, serviços em Docker, o bot do Telegram (criar, configurar), convites com QR e acessos;
 * cria, instala (com a confirmação de código), atualiza e remove fitas.
 */
export class AdminServer {
  private readonly logger = new Logger('Admin');
  private readonly token: string;
  private readonly runner: FitaRunner;
  private readonly services: FitaServices;
  private readonly managed = new Map<string, ManagedJob>();
  private server?: http.Server;

  constructor(private readonly options: AdminServerOptions) {
    this.token = options.token ?? randomBytes(24).toString('base64url');
    this.runner = options.runner ?? new FitaRunner({ rootDir: options.rootDir, webPortBase: 8810 });
    this.services = options.services ?? new FitaServices();
  }

  get url(): string {
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.options.port;
    return `http://127.0.0.1:${port}/#t=${this.token}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Por padrão só no próprio computador: a página liga processos e grava arquivos.
      this.server!.listen(this.options.port, this.options.host ?? '127.0.0.1', () => resolve());
    });
  }

  /** Liga uma fita como o botão Ligar da página (ADMIN_LIGAR: as que sobem junto com a administração). */
  ligar(nome: string): void {
    const fita = listProfiles(this.dirs).find((p) => p.name === nome);
    if (!fita) throw new Error(`fita "${nome}" não encontrada`);
    this.checkOwnBot(nome, fita.dir);
    this.runner.start(nome);
  }

  async stop(): Promise<void> {
    for (const job of this.managed.values()) job.abort.abort();
    await this.runner.stopAll();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private get dirs(): string[] {
    return profileDirs(this.options.env, this.options.rootDir);
  }

  private installer(confirm: (request: CodeConfirmation) => Promise<boolean>): ProfileInstaller {
    return new ProfileInstaller({
      profilesDir: this.dirs[0]!,
      playerVersion: playerVersion(this.options.rootDir),
      ...(this.options.env.npm_execpath ? { npmCliPath: this.options.env.npm_execpath } : {}),
      log: (line) => this.logger.info(line),
      confirmCode: confirm,
    });
  }

  private readonly botNames = new Map<string, string>();

  private get setup(): TelegramBotSetup {
    const { TELEGRAM_API_ROOT: apiRoot, TELEGRAM_PAGINA_ROOT: paginaRoot } = this.options.env;
    return new TelegramBotSetup({ ...(apiRoot ? { apiRoot } : {}), ...(paginaRoot ? { paginaRoot } : {}) });
  }

  private telegram(fita: string): FitaTelegram {
    return new FitaTelegram(fita, { env: this.options.env, rootDir: this.options.rootDir });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      this.checkHost(req);
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/') return this.sendPage(res);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return void res.writeHead(204).end();
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Não encontrado');
      const quem = await this.quem(req);
      // Pedido que muda algo precisa vir da própria página (JSON): formulários de outros sites não conseguem.
      if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Envie JSON');

      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/eu') return this.json(res, quem);
      this.autorizar(quem.papel, req.method ?? 'GET', p);
      if (p === '/api/pessoas') return await this.pessoasRoute(req, res);
      if (req.method === 'GET' && p === '/api/fitas') return this.json(res, await this.listFitas());
      if (req.method === 'GET' && p === '/api/bots') return this.json(res, await this.bots());
      if (req.method === 'POST' && p === '/api/fitas') {
        const { nome } = (await this.readJson(req)) as { nome?: string };
        if (!nome || !PROFILE_NAME_PATTERN.test(nome)) throw new HttpError(400, 'Nome inválido: letras minúsculas, números e hífen (ex.: minha-fita)');
        if (this.find(nome, false)) throw new HttpError(409, `Já existe a fita "${nome}"`);
        createProfile(this.dirs[0]!, nome, playerVersion(this.options.rootDir));
        return this.json(res, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/instalar') {
        const body = (await this.readJson(req)) as { origem?: string; nome?: string; confiar?: boolean };
        if (!body.origem?.trim()) throw new HttpError(400, 'Informe a origem (pasta, URL Git, usuario/nome ou @escopo/nome)');
        return this.json(res, await this.withCodeConfirmation(body.confiar === true, (installer) => installer.install(body.origem!.trim(), body.nome ? { name: body.nome } : {})));
      }

      const fitaRoute = /^\/api\/fitas\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/.exec(p);
      if (!fitaRoute) throw new HttpError(404, 'Não encontrado');
      const nome = fitaRoute[1]!;
      const rest = fitaRoute[2] ?? '';
      const fita = this.find(nome, true)!;

      if (req.method === 'DELETE' && rest === '') {
        const body = (await this.readJson(req)) as { confirmacao?: string; apagarDados?: boolean };
        if (body.confirmacao !== nome) throw new HttpError(400, 'Digite o nome da fita para confirmar');
        if (path.dirname(fita.dir) !== path.resolve(this.dirs[0]!)) throw new HttpError(400, 'Só dá para remover fitas da primeira pasta de PERFIS_DIR');
        await this.runner.stop(nome);
        this.managed.get(nome)?.abort.abort();
        this.installer(async () => false).remove(nome, body.apagarDados ? { dataDir: path.join(this.options.rootDir, 'dados', nome) } : {});
        return this.json(res, { ok: true });
      }
      if (req.method === 'POST' && rest === '/atualizar') {
        const body = (await this.readJson(req)) as { confiar?: boolean };
        return this.json(res, await this.withCodeConfirmation(body.confiar === true, (installer) => installer.update(nome)));
      }
      if (req.method === 'POST' && rest === '/manifesto') return this.json(res, this.editManifest(fita.dir, (await this.readJson(req)) as Record<string, unknown>));
      if (req.method === 'POST' && (rest === '/ligar' || rest === '/desligar')) {
        if (rest === '/ligar') this.checkOwnBot(nome, fita.dir);
        return this.json(res, rest === '/ligar' ? this.runner.start(nome) : await this.runner.stop(nome));
      }
      if (req.method === 'GET' && rest === '/log') return this.json(res, { linhas: this.runner.log(nome), ...this.runner.state(nome) });

      if (req.method === 'GET' && rest === '/servicos') return this.json(res, await this.services.state(fita.dir));
      const service = /^\/servicos\/([\w.-]+)\/(ligar|desligar)$/.exec(rest);
      if (req.method === 'POST' && service) return this.json(res, await this.services.set(fita.dir, service[1]!, service[2] === 'ligar'));

      if (rest.startsWith('/telegram')) return await this.telegramRoute(req, res, nome, rest.slice('/telegram'.length));
      throw new HttpError(404, 'Não encontrado');
    } catch (error) {
      // Erros esperados (perfil inválido, fita sem bot, token recusado pelo Telegram) voltam 400 com a explicação.
      const expected = error instanceof ProfileError || error instanceof UserFacingError || error instanceof GrammyError;
      const status = error instanceof HttpError ? error.status : expected ? 400 : 500;
      const message =
        error instanceof UserFacingError ? error.userMessage : error instanceof GrammyError ? `Telegram: ${error.description}` : error instanceof Error ? error.message : String(error);
      if (status === 500) this.logger.error(`Falha na administração: ${message}`, error);
      if (!res.headersSent) this.json(res, { erro: message, ...(error instanceof HttpError ? error.extra : {}) }, status);
      else res.destroy();
    }
  }

  private async telegramRoute(req: http.IncomingMessage, res: http.ServerResponse, nome: string, rest: string): Promise<void> {
    const telegram = this.telegram(nome);
    if (req.method === 'GET' && rest === '') {
      const job = this.managed.get(nome);
      let bot: { username: string; nome: string } | null = null;
      let botErro: string | null = null;
      try {
        const info = await telegram.bot();
        bot = info ? { username: info.username, nome: info.nome } : null;
      } catch (error) {
        botErro = error instanceof Error ? error.message : String(error);
      }
      return this.json(res, {
        bot,
        botErro,
        gerenteConfigurado: Boolean(this.options.env.TELEGRAM_GERENTE_TOKEN?.trim()),
        criacao: job ? { estado: job.estado, link: job.link, qr: job.qr, nome: job.nome, sugestao: job.sugestao, ocupados: job.ocupados, bot: job.bot ?? null, erro: job.erro ?? null } : null,
        ...telegram.overview(),
      });
    }
    if (req.method === 'POST' && rest === '/convites') {
      const body = (await this.readJson(req)) as { nome?: string; dias?: number; usos?: number };
      const { invite, link, aviso } = await telegram.invite({
        ...(body.nome?.trim() ? { nome: body.nome.trim() } : {}),
        ...(body.dias ? { dias: Number(body.dias) } : {}),
        ...(body.usos ? { usos: Number(body.usos) } : {}),
      });
      return this.json(res, { invite, link, qr: await qrDataUrl(link), aviso: aviso ?? null });
    }
    const invite = /^\/convites\/([A-Za-z0-9_-]{8,64})\/cancelar$/.exec(rest);
    if (req.method === 'POST' && invite) return this.json(res, { ok: telegram.revokeInvite(invite[1]!) });
    const person = /^\/pessoas\/(\d{1,20})$/.exec(rest);
    if (person && req.method === 'POST') {
      const { status } = (await this.readJson(req)) as { status?: AccessStatus };
      if (!status || !['ativo', 'bloqueado', 'pendente'].includes(status)) throw new HttpError(400, 'status: ativo, bloqueado ou pendente');
      return this.json(res, { ok: Boolean(telegram.setStatus(Number(person[1]), status)) });
    }
    if (person && req.method === 'DELETE') return this.json(res, { ok: telegram.removePerson(Number(person[1])) });
    if (req.method === 'POST' && rest === '/bot/token') {
      const { token } = (await this.readJson(req)) as { token?: string };
      if (!token?.trim() || !/^\d+:[\w-]{20,}$/.test(token.trim())) throw new HttpError(400, 'Token inválido (formato 123456:ABC...)');
      const result = await telegram.connectToken(token);
      return this.json(res, { bot: { username: result.bot.username, nome: result.bot.nome }, feitos: result.feitos, falhas: result.falhas });
    }
    if (req.method === 'POST' && rest === '/bot/sincronizar') return this.json(res, await telegram.sync());
    if (req.method === 'POST' && rest === '/bot/gerente') {
      const managerToken = this.options.env.TELEGRAM_GERENTE_TOKEN?.trim();
      if (!managerToken) throw new HttpError(400, 'Defina TELEGRAM_GERENTE_TOKEN no .env do K7 (o bot gerente) e reinicie a administração');
      // `nome`: o nome do bot (padrão: o da fita). `outro`: o Telegram recusou o @ sugerido; tenta o próximo livre.
      const body = (await this.readJson(req)) as { nome?: string; outro?: boolean };
      const anterior = this.managed.get(nome);
      anterior?.abort.abort();
      const tentados = body.outro && anterior ? anterior.tentados : [];
      const escolhido = typeof body.nome === 'string' && body.nome.trim() ? body.nome.trim().slice(0, 64) : body.outro && anterior ? anterior.nome : undefined;
      const r = await telegram.managedLink(managerToken, { ...(escolhido ? { nome: escolhido } : {}), excluir: tentados });
      const job: ManagedJob = { estado: 'esperando', link: r.link, qr: await qrDataUrl(r.link), nome: r.nome, sugestao: r.sugestao, tentados: [...tentados, r.sugestao], ocupados: r.ocupados, abort: new AbortController() };
      this.managed.set(nome, job);
      // Espera a confirmação no Telegram em segundo plano; a página consulta o estado.
      void telegram
        .completeManaged(managerToken, 15 * 60_000, job.abort.signal, r.nome)
        .then((created) => Object.assign(job, { estado: 'pronto', bot: created.bot.username }))
        .catch((error: unknown) => {
          if (!job.abort.signal.aborted) Object.assign(job, { estado: 'erro', erro: error instanceof Error ? error.message : String(error) });
        });
      return this.json(res, { estado: job.estado, link: job.link, qr: job.qr, nome: job.nome, sugestao: job.sugestao, ocupados: job.ocupados });
    }
    throw new HttpError(404, 'Não encontrado');
  }

  /**
   * Os bots do Telegram das fitas (pelo token no .env de cada uma). Cada fita deve ter o próprio bot: `dividido` aponta
   * fitas que usam o mesmo (só uma responde por vez e as conversas se misturam) e `semBot` as que têm o canal
   * Telegram sem token. A página oferece criar o bot pelo gerente.
   */
  private async bots() {
    const groups = new Map<string, { token: string; fitas: string[] }>();
    const semBot: string[] = [];
    for (const { name, dir, manifest } of listProfiles(this.dirs)) {
      const token = botToken(dir);
      if (!token) {
        if ((manifest?.canais ?? ['telegram', 'terminal']).includes('telegram')) semBot.push(name);
        continue;
      }
      const id = token.split(':')[0]!;
      const group = groups.get(id) ?? { token, fitas: [] };
      group.fitas.push(name);
      groups.set(id, group);
    }
    const bots = await Promise.all(
      [...groups].map(async ([id, group]) => {
        let username: string | null = this.botNames.get(id) ?? null;
        if (!username) {
          try {
            username = (await this.setup.info(group.token)).username || null;
            if (username) this.botNames.set(id, username);
          } catch {
            // Token recusado ou sem rede: a página mostra o número do bot.
          }
        }
        return { id, username, fitas: group.fitas, ligadas: group.fitas.filter((n) => this.runner.state(n).rodando), dividido: group.fitas.length > 1 };
      }),
    );
    return { bots, semBot, gerenteConfigurado: Boolean(this.options.env.TELEGRAM_GERENTE_TOKEN?.trim()) };
  }

  /** Ligar uma fita cujo bot já responde por outra fita ligada derrubaria a outra (o Telegram só atende um programa). */
  private checkOwnBot(nome: string, dir: string): void {
    const token = botToken(dir);
    if (!token) return;
    const id = token.split(':')[0];
    const other = listProfiles(this.dirs).find((p) => p.name !== nome && botToken(p.dir)?.split(':')[0] === id && this.runner.state(p.name).rodando);
    if (other) {
      throw new HttpError(
        409,
        `O bot desta fita é o mesmo da "${other.name}", que está ligada: só uma responderia e as conversas se misturariam. ` +
          `Crie um bot próprio para "${nome}" na aba Telegram (Criar bot pelo gerente).`,
      );
    }
  }

  private async listFitas() {
    const registry = this.installer(async () => false).readRegistry();
    return listProfiles(this.dirs).map(({ name, dir, manifest, error }) => {
      const text = readText(path.join(dir, 'perfil.yaml'));
      const envText = readText(path.join(dir, '.env'));
      const off = text ? disabledExtension(text) : undefined;
      return {
        nome: name,
        dir,
        erro: error ?? null,
        titulo: manifest?.identidade.nome ?? name,
        emoji: manifest?.identidade.emoji ?? '📼',
        descricao: manifest?.descricao ?? '',
        versao: manifest?.versao ?? null,
        canais: manifest?.canais ?? ['telegram', 'terminal'],
        modulos: manifest?.modulos ?? [],
        vitrine: manifest?.vitrine === true,
        privacidade: manifest?.privacidade ?? null,
        extensao: manifest?.extensao ? { caminho: manifest.extensao, ligada: true } : off ? { caminho: off, ligada: false } : null,
        telegram: { modo: manifest?.telegram?.acesso ?? 'lista', temToken: /^TELEGRAM_BOT_TOKEN=\s*\S/m.test(envText) },
        codigo: safeCode(dir),
        origem: registry[name]?.origem ?? null,
        removivel: path.dirname(dir) === path.resolve(this.dirs[0]!),
        servicos: this.services.list(dir).map((s) => s.nome),
        processo: this.runner.state(name),
      };
    });
  }

  private editManifest(dir: string, body: Record<string, unknown>) {
    const changes: ManifestChanges = {};
    if (typeof body.vitrine === 'boolean') changes.vitrine = body.vitrine;
    if (Array.isArray(body.canais)) {
      const canais = body.canais.map(String);
      if (!canais.every((c) => (CHANNELS as readonly string[]).includes(c))) throw new HttpError(400, `Canais: ${CHANNELS.join(', ')}`);
      changes.canais = canais as ChannelId[];
    }
    if (typeof body.extensaoLigada === 'boolean') changes.extensaoLigada = body.extensaoLigada;
    if (typeof body.telegramAcesso === 'string') {
      if (!TELEGRAM_ACCESS_MODES.includes(body.telegramAcesso as TelegramAccessMode)) throw new HttpError(400, `Acesso: ${TELEGRAM_ACCESS_MODES.join(', ')}`);
      changes.telegramAcesso = body.telegramAcesso as TelegramAccessMode;
    }
    const file = path.join(dir, 'perfil.yaml');
    fs.writeFileSync(file, editManifest(fs.readFileSync(file, 'utf8'), changes));
    return { ok: true, reiniciar: 'Reinicie a fita (desligar e ligar) para valer.' };
  }

  /** Instala/atualiza: sem `confiar`, uma fita com código volta 409 com a lista de arquivos para a pessoa decidir. */
  private async withCodeConfirmation<T extends { name: string; dir: string }>(trust: boolean, run: (installer: ProfileInstaller) => Promise<T>) {
    let files: string[] = [];
    try {
      const result = await run(
        this.installer(async (request) => {
          files = request.files;
          return trust;
        }),
      );
      return { ok: true, nome: result.name, dir: result.dir, codigo: files };
    } catch (error) {
      if (!trust && files.length) throw new HttpError(409, 'A fita traz código: confira os arquivos e confirme.', { precisaConfirmar: true, arquivos: files });
      throw error;
    }
  }

  private find(nome: string, required: boolean) {
    const found = listProfiles(this.dirs).find((p) => p.name === nome);
    if (!found && required) throw new HttpError(404, `Fita "${nome}" não encontrada`);
    return found;
  }

  private sendPage(res: http.ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(fs.readFileSync(PAGE, 'utf8').replaceAll('__NONCE__', nonce));
  }

  private checkHost(req: http.IncomingMessage): void {
    const address = this.server?.address();
    const port = address && typeof address === 'object' ? address.port : this.options.port;
    const host = String(req.headers.host ?? '').toLowerCase();
    if (new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(host)) return;
    if (!(this.options.dominios ?? []).includes(host)) throw new HttpError(421, 'Host não permitido');
    if (!req.headers['cf-access-jwt-assertion']) throw new HttpError(403, 'Este endereço só abre pelo Cloudflare Access');
  }

  /** No próprio computador: o token (dono). Pelo domínio: o e-mail do login do Access e o papel dele. */
  private async quem(req: http.IncomingMessage): Promise<{ email: string | null; papel: Papel; local: boolean }> {
    const jwt = req.headers['cf-access-jwt-assertion'];
    if (!jwt) {
      this.checkToken(req.headers['x-token']);
      return { email: null, papel: 'dono', local: true };
    }
    if (!this.options.acesso || !this.options.pessoas) throw new HttpError(503, 'Login pelo domínio não configurado (CF_ACCESS_EQUIPE e CF_ACCESS_AUD no .env do K7)');
    let email: string;
    try {
      email = await this.options.acesso.email(String(jwt));
    } catch (error) {
      throw new HttpError(401, error instanceof Error ? error.message : String(error));
    }
    const papel = this.options.pessoas.papel(email);
    if (!papel) throw new HttpError(403, `${email} ainda não tem acesso. Peça a um dono para incluir seu e-mail na aba Pessoas.`, { email });
    return { email, papel, local: false };
  }

  /** Leitor só vê; instalar/atualizar/remover fitas (código) e a aba Pessoas são do dono. */
  private autorizar(papel: Papel, method: string, p: string): void {
    if (papel === 'dono') return;
    const soDono = p === '/api/pessoas' || p === '/api/instalar' || (method === 'DELETE' && /^\/api\/fitas\/[^/]+$/.test(p)) || p.endsWith('/atualizar');
    if (soDono) throw new HttpError(403, 'Só um dono pode fazer isso');
    if (papel === 'leitor' && method !== 'GET') throw new HttpError(403, 'Seu acesso é só para ver');
  }

  private async pessoasRoute(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pessoas = this.options.pessoas;
    if (!pessoas) throw new HttpError(400, 'Login pelo domínio não configurado (CF_ACCESS_EQUIPE e CF_ACCESS_AUD no .env do K7)');
    if (req.method === 'POST' || req.method === 'DELETE') {
      const body = (await this.readJson(req)) as { email?: string; papel?: string };
      try {
        // definir() recusa papel fora de PAPEIS.
        if (req.method === 'POST') pessoas.definir(String(body.email ?? ''), String(body.papel) as Papel);
        else pessoas.remover(String(body.email ?? ''));
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    } else if (req.method !== 'GET') throw new HttpError(405, 'Método não permitido');
    return this.json(res, { pessoas: pessoas.listar() });
  }

  private checkToken(received: string | string[] | undefined): void {
    const value = Buffer.from(String(Array.isArray(received) ? received[0] : (received ?? '')));
    const expected = Buffer.from(this.token);
    if (value.length !== expected.length || !timingSafeEqual(value, expected)) throw new HttpError(401, 'Token inválido; abra o endereço mostrado no terminal');
  }

  private async readJson(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 64 * 1024) throw new HttpError(413, 'Pedido grande demais');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON inválido');
    }
  }

  private json(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
}

/** TELEGRAM_BOT_TOKEN do .env da fita (o token não é herdado do .env do K7). */
function botToken(dir: string): string | undefined {
  return /^TELEGRAM_BOT_TOKEN=\s*"?([^"\s]+)"?\s*$/m.exec(readText(path.join(dir, '.env')))?.[1];
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function safeCode(dir: string): number {
  try {
    return inspectProfile(dir).code.length;
  } catch {
    return 0;
  }
}
