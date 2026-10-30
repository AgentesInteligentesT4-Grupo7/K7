import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrDataUrl } from '../telegram/acesso/convite.js';
import type { AccessStatus } from '../telegram/acesso/TelegramAccessStore.js';
import { FitaTelegram } from '../telegram/configuracao/FitaTelegram.js';
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
import { FitaRunner } from './FitaRunner.js';
import { FitaServices } from './FitaServices.js';

const PAGE = fileURLToPath(new URL('../../../web/admin.html', import.meta.url));

export interface AdminServerOptions {
  port: number;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  /** Fixo (ADMIN_TOKEN) ou gerado a cada início. */
  token?: string;
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
      // Sempre só no próprio computador: a página liga processos e grava arquivos.
      this.server!.listen(this.options.port, '127.0.0.1', () => resolve());
    });
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
      this.checkToken(req.headers['x-token']);
      // Pedido que muda algo precisa vir da própria página (JSON): formulários de outros sites não conseguem.
      if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Envie JSON');

      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/fitas') return this.json(res, await this.listFitas());
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
        criacao: job ? { estado: job.estado, link: job.link, qr: job.qr, bot: job.bot ?? null, erro: job.erro ?? null } : null,
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
      this.managed.get(nome)?.abort.abort();
      const { link } = await telegram.managedLink(managerToken);
      const job: ManagedJob = { estado: 'esperando', link, qr: await qrDataUrl(link), abort: new AbortController() };
      this.managed.set(nome, job);
      // Espera a confirmação no Telegram em segundo plano; a página consulta o estado.
      void telegram
        .completeManaged(managerToken, 15 * 60_000, job.abort.signal)
        .then((created) => Object.assign(job, { estado: 'pronto', bot: created.bot.username }))
        .catch((error: unknown) => Object.assign(job, { estado: 'erro', erro: error instanceof Error ? error.message : String(error) }));
      return this.json(res, { estado: job.estado, link: job.link, qr: job.qr });
    }
    throw new HttpError(404, 'Não encontrado');
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
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(String(req.headers.host ?? '').toLowerCase())) throw new HttpError(421, 'Host não permitido');
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
