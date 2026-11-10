import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AgentController } from '../../agent/AgentController.js';
import { ProgressBoard } from '../../agent/ProgressBoard.js';
import type { AgentInput } from '../../agent/types.js';
import type { Core } from '../../app/createCore.js';
import { type ExtensionRoute, fromExtension } from '../../fitas/ExtensionHost.js';
import type { WebRotaCtx } from '../../fitas/FitaApi.js';
import { DocumentParseError, EmptyAudioError, UnsupportedAttachmentError, UserFacingError, errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { sanitizeText, truncate } from '../../utils/text.js';
import { AttachmentService } from '../../modules/anexos/AttachmentService.js';
import { AudioIntentDetector } from '../../voice/AudioIntentDetector.js';
import { qrDataUrl } from '../telegram/acesso/convite.js';
import { TelegramBotSetup } from '../telegram/configuracao/TelegramBotSetup.js';
import { renderPage } from './page.js';
import { type PendingResult, PendingRequests } from './PendingRequests.js';
import { type WebReply, WebOutputHandler } from './WebOutputHandler.js';
import { ZipTooLargeError, writeZip, zipSize } from './ZipStream.js';

export interface WebChannelOptions {
  host: string;
  port: number;
  /** Token exigido pela API; gerado a cada início se não vier de WEB_TOKEN. */
  token?: string;
  userId: string;
  /**
   * WEB_PUBLIC=on: endereço aberto, sem token. Cada navegador vira um visitante com conversas, memória e arquivos
   * próprios; mensagens limitadas por visitante e no total (protege as chaves das LLMs); sem voz clonada.
   */
  public?: boolean;
  /** Mensagens por hora de cada visitante (WEB_PUBLIC_LIMIT). */
  publicLimit?: number;
  /** Mensagens por hora somando todos os visitantes (WEB_PUBLIC_LIMIT_TOTAL). */
  publicLimitTotal?: number;
}

interface MessageBody {
  texto?: string;
  responderEmAudio?: boolean;
  anexo?: { nome: string; tipo?: string; base64: string };
  audio?: { tipo?: string; base64: string };
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
};
const MEDIA_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const HOUR_MS = 3600_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Canal web: chat no navegador no estilo do app desktop do Claude (conversas na lateral,
 * Markdown, anexos, microfone, áudio). Só escuta em 127.0.0.1 por padrão; a API exige o
 * token da URL (cabeçalho X-Token) e confere o Host, então outros sites abertos no
 * navegador não conseguem usar o agente (CSRF / DNS rebinding).
 */
export class WebChannel {
  private readonly logger = new Logger('Web');
  private readonly token: string;
  private readonly output: WebOutputHandler;
  private readonly controller: AgentController;
  private server?: http.Server;
  /** Fila de mensagens de cada visitante (como a fila por chat do Telegram). */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Horários das mensagens recentes por visitante ('*' = todos), para o limite do modo público. */
  private readonly hits = new Map<string, number[]>();
  /** Pedidos longos respondidos aos poucos (sem conexão aberta por minutos, que o Cloudflare corta com 524). */
  private readonly pending = new PendingRequests();

  constructor(
    private readonly core: Core,
    private readonly options: WebChannelOptions,
  ) {
    this.token = options.token ?? randomBytes(24).toString('base64url');
    this.output = new WebOutputHandler({
      outputDir: path.resolve(path.dirname(core.config.dbPath), 'web'),
      tts: core.tts,
      clonedVoices: core.voiceClone,
    });
    this.controller = core.createController(this.output);
  }

  /** Endereço para abrir no navegador (o token vai no fragmento #, que nunca é enviado ao servidor; público: sem token). */
  get url(): string {
    const host = this.options.host === '0.0.0.0' || this.options.host === '::' ? '127.0.0.1' : this.options.host;
    const base = `http://${host}:${this.address?.port ?? this.options.port}/`;
    return this.options.public ? base : `${base}#t=${this.token}`;
  }

  /** Endereços pelos quais outras máquinas alcançam o canal público (IPs da rede local e de VPN). */
  get networkUrls(): string[] {
    if (!this.options.public || !['0.0.0.0', '::'].includes(this.options.host)) return [];
    const port = this.address?.port ?? this.options.port;
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((net) => net && net.family === 'IPv4' && !net.internal)
      .map((net) => `http://${net!.address}:${port}/`);
  }

  private get address(): { port: number } | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address : undefined;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    // Sem teto: respostas com modelos locais e tarefas longas das fitas passam de uma hora (a página mostra o andamento).
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 60 * 1000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, this.options.host, () => resolve());
    });
    if (this.options.public) {
      this.logger.warn(
        `⚠️ Canal web PÚBLICO: sem token; cada navegador é um visitante isolado, ` +
          `até ${this.options.publicLimit ?? 20} mensagens/hora por visitante e ${this.options.publicLimitTotal ?? 200} no total`,
      );
      for (const address of this.networkUrls) this.logger.info(`🌐 Na rede: ${address}`);
    } else if (!['127.0.0.1', 'localhost', '::1'].includes(this.options.host)) {
      this.logger.warn(`⚠️ Canal web aberto na rede (${this.options.host}); qualquer pessoa com o token acessa o agente`);
    }
    this.logger.info(`🌐 Chat web: ${this.url}`);
  }

  async stop(): Promise<void> {
    this.pending.stop();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      // Público: qualquer Host (IP da rede, VPN, domínio de um túnel); sem token não há o que proteger do rebinding.
      if (!this.options.public) this.checkHost(req);
      if (req.method === 'GET' && url.pathname === '/') return this.sendPage(res);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return void res.writeHead(204).end();
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Não encontrado');

      // Arquivos são abertos por <audio>/<a>, que não mandam cabeçalho: o token vem na query.
      // Público: os arquivos têm nome imprevisível (WebOutputHandler), então não pedem token nem visitante.
      if (!this.options.public) this.checkToken(req.headers['x-token'] ?? url.searchParams.get('t') ?? undefined);
      const files = /^\/api\/arquivos\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && files) return this.sendFile(res, decodeURIComponent(files[1]!));
      const bundle = /^\/api\/pacotes\/([0-9a-f]{24})$/.exec(url.pathname);
      // await: sem ele, o erro (404, 413) escaparia do catch e a requisição ficaria sem resposta.
      if (req.method === 'GET' && bundle) return await this.sendZip(res, bundle[1]!, url.searchParams.get('nome'));
      // Rotas da extensão da fita (/api/x/...). As de `visitante: false` (ex.: arquivos abertos por <audio>) vêm sem cabeçalho.
      const extension = this.core.extensions.routes.find((r) => r.method === req.method && r.path.test(url.pathname));
      if (extension) return await this.runExtension(extension, req, res, url);
      const userId = this.userIdFor(req);
      const pendingId = /^\/api\/pedidos\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
      if (req.method === 'GET' && pendingId) {
        const result = await this.pending.wait(userId, pendingId[1]!, 25_000);
        if (result === undefined) throw new HttpError(404, 'A resposta deste pedido se perdeu (o servidor reiniciou). Mande de novo.');
        return result ? this.json(res, result.data, result.status) : this.json(res, { pendente: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/info') return this.json(res, this.info());
      if (req.method === 'GET' && url.pathname === '/api/telegram') {
        const telegram = await this.telegramLink();
        if (!telegram) throw new HttpError(404, 'Esta fita não tem bot do Telegram aberto');
        return this.json(res, telegram);
      }
      if (req.method === 'GET' && url.pathname === '/api/progresso') {
        const progress = ProgressBoard.get(userId);
        return this.json(res, { texto: progress?.text ?? null, feitos: progress?.done ?? null, total: progress?.total ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/api/conversas') return this.json(res, this.conversations(userId));
      if (req.method === 'POST' && url.pathname === '/api/conversas') {
        this.controller.newConversation(userId);
        return this.json(res, { ok: true });
      }
      const conversation = /^\/api\/conversas\/([0-9a-f-]{36})(\/abrir)?$/.exec(url.pathname);
      if (conversation && req.method === 'GET' && !conversation[2]) return this.json(res, this.history(userId, conversation[1]!));
      if (conversation && req.method === 'POST' && conversation[2]) {
        if (!this.core.memory.activateConversation(userId, conversation[1]!)) throw new HttpError(404, 'Conversa não encontrada');
        return this.json(res, { ok: true });
      }
      // Fechar a conversa = excluir o histórico dela (só do próprio visitante).
      if (conversation && req.method === 'DELETE' && !conversation[2]) {
        if (!this.core.memory.deleteConversation(userId, conversation[1]!)) throw new HttpError(404, 'Conversa não encontrada');
        return this.json(res, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/mensagens') {
        const id = PendingRequests.validId(req.headers['x-pedido']) ? req.headers['x-pedido'] : undefined;
        // Repetição do mesmo envio (a rede falhou antes da resposta): o pedido já está andando.
        if (id && this.pending.has(userId, id)) return this.json(res, { pedido: id }, 202);
        const body = (await this.readJson(req)) as MessageBody;
        if (this.options.public) this.checkLimit(userId);
        if (!id) return this.json(res, await this.enqueue(userId, () => this.message(body, userId)));
        this.pending.start(userId, id, () => this.asResult(() => this.enqueue(userId, () => this.message(body, userId))));
        return this.json(res, { pedido: id }, 202);
      }
      if (req.method === 'POST' && url.pathname === '/api/falar') {
        // Voz clonada num endereço aberto deixaria qualquer um falar com a voz do dono.
        if (this.options.public) throw new HttpError(403, 'Voz clonada desligada no modo público');
        const body = (await this.readJson(req)) as { texto?: string; voz?: string };
        if (!body.texto?.trim()) throw new HttpError(400, 'Informe o texto');
        return this.json(res, await this.enqueue(userId, () => this.output.speakClonedOnly(body.texto!.trim(), body.voz?.trim() || undefined)));
      }
      throw new HttpError(404, 'Não encontrado');
    } catch (error) {
      const { status, data } = this.errorResult(error);
      if (!res.headersSent) this.json(res, data, status);
      // Erro no meio de um envio (ex.: .zip): fecha a conexão para o download falhar em vez de ficar pendurado.
      else res.destroy();
    }
  }

  /** O que a rota responderia, guardado para a página buscar depois (pedido longo). */
  private async asResult(task: () => Promise<unknown>): Promise<PendingResult> {
    try {
      return { status: 200, data: await task() };
    } catch (error) {
      return this.errorResult(error);
    }
  }

  private errorResult(error: unknown): PendingResult {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) this.logger.error(`Falha no canal web: ${errorMessage(error)}`, error);
    return { status, data: { erro: status === 500 ? 'Falha interna; veja os logs.' : (error as Error).message } };
  }

  private async message(body: MessageBody, userId: string): Promise<WebReply & { modelo?: string; transcricao?: string }> {
    // Comandos de memória, persona, estilo e modo respondem direto, sem passar pelo LLM.
    const command = /^\/(memoria|esquecer|persona|estilo|modo)\b\s*(.*)$/is.exec((body.texto ?? '').trim());
    if (command && !body.anexo && !body.audio) {
      const arg = command[2] ?? '';
      const commands: Record<string, () => string> = {
        memoria: () => this.controller.memoryReport(userId),
        esquecer: () => this.controller.forget(userId, arg),
        persona: () => this.controller.personaCommand(userId, arg),
        estilo: () => this.controller.styleCommand(userId, arg),
        modo: () => this.controller.modeCommand(userId, arg),
      };
      return { texto: commands[command[1]!.toLowerCase()]!(), arquivos: [], audios: [], imagens: [], avisos: [] };
    }
    let input: AgentInput;
    try {
      input = await this.buildInput(body, userId);
    } catch (error) {
      if (!(error instanceof UserFacingError)) throw error;
      return { texto: '', arquivos: [], audios: [], imagens: [], avisos: [], erro: `⚠️ ${error.userMessage}` };
    }
    const { chatId, reply } = this.output.begin();
    await this.controller.handle({ ...input, chatId });
    const result = await reply;
    const decision = this.core.orchestrator?.provider.lastDecision(userId);
    return { ...result, modelo: decision?.model ?? `${this.core.llm.name}/${this.core.llm.model}`, ...(input.source === 'voice' ? { transcricao: input.text } : {}) };
  }

  private async buildInput(body: MessageBody, userId: string): Promise<AgentInput> {
    const text = (body.texto ?? '').trim();
    const base = { userId, chatId: 0, channel: 'web' as const };
    const audioReply = (spoken: string, isVoice: boolean) => body.responderEmAudio === true || AudioIntentDetector.resolve(spoken, isVoice);
    const withVoice = (requiresAudioReply: boolean) => (requiresAudioReply ? { requiresAudioReply, voiceId: this.core.tts.voice } : { requiresAudioReply });

    if (body.audio) {
      const extension = AUDIO_EXTENSIONS[(body.audio.tipo ?? '').split(';')[0]!.trim()] ?? '.webm';
      const file = this.writeTemp(extension, body.audio.base64);
      let transcript: string;
      try {
        transcript = (await this.core.stt.transcribe(file)).trim();
      } finally {
        await this.core.tmp.remove(file);
      }
      if (!transcript) throw new EmptyAudioError();
      const spoken = text ? `${text}\n\n${transcript}` : transcript;
      return { ...base, text: spoken, source: 'voice', ...withVoice(audioReply(spoken, true)) };
    }

    // Módulo anexos: imagem ou documento vai para a biblioteca (referência + trecho, imagem para visão).
    if (body.anexo && this.core.attachments) {
      const name = path.basename(body.anexo.nome || 'arquivo');
      if (!AttachmentService.supports(name, body.anexo.tipo)) throw new UnsupportedAttachmentError(name);
      const data = Buffer.from(body.anexo.base64, 'base64');
      if (data.length === 0) throw new UserFacingError('Arquivo vazio.');
      if (data.length > this.core.config.maxDocumentBytes) throw new UserFacingError('Arquivo grande demais.');
      const item = await this.core.attachments.ingest({ userId, name, mime: body.anexo.tipo ?? '', data, caption: text });
      const built = this.core.attachments.buildInput([item], text);
      return {
        ...base,
        text: built.text,
        source: built.images.length ? 'image' : 'document',
        attachmentName: built.attachmentName,
        ...(built.images.length ? { images: built.images } : {}),
        ...withVoice(audioReply(text, false)),
      };
    }

    if (body.anexo) {
      const name = path.basename(body.anexo.nome || 'documento');
      const extractor = this.core.documents.find(name, body.anexo.tipo);
      if (!extractor) throw new UnsupportedAttachmentError(name);
      const file = this.writeTemp(extractor.extension, body.anexo.base64);
      let content: string;
      try {
        content = await extractor.extract(file);
      } catch (error) {
        throw new DocumentParseError(name, error);
      } finally {
        await this.core.tmp.remove(file);
      }
      content = truncate(sanitizeText(content).trim() || '[Documento sem texto extraível]', this.core.config.maxDocumentChars);
      return {
        ...base,
        text: `${text || 'Analise o documento anexado.'}\n\n[Documento anexado: ${name}]\n${content}`,
        source: 'document',
        attachmentName: name,
        ...withVoice(audioReply(text, false)),
      };
    }

    if (!text) throw new UserFacingError('Escreva uma mensagem, anexe um arquivo ou grave um áudio.');
    return { ...base, text, source: 'text', ...withVoice(audioReply(text, false)) };
  }

  private writeTemp(extension: string, base64: string): string {
    const data = Buffer.from(base64, 'base64');
    if (data.length === 0) throw new UserFacingError('Arquivo vazio.');
    if (data.length > this.core.config.maxDocumentBytes) throw new UserFacingError('Arquivo grande demais.');
    const file = this.core.tmp.createPath(extension);
    fs.writeFileSync(file, data);
    return file;
  }

  private info() {
    const { config } = this.core;
    return {
      nome: config.identity.name,
      emoji: config.identity.emoji,
      dono: config.identity.owner,
      perfil: config.profileName ?? null,
      modulos: [...config.modules],
      skills: this.controller.listSkills().map((s) => ({ nome: s.name, descricao: s.description })),
      llm: this.core.llm.providerNames,
      voz: config.modules.has('voz'),
      // Público: os nomes das vozes clonadas do dono não aparecem (e o /api/falar fica desligado).
      vozes: this.options.public ? null : (this.core.voiceClone?.list().map((v) => v.name) ?? null),
      publico: this.options.public === true,
      telegram: this.telegramAberto(),
    };
  }

  /** O bot desta fita aceita qualquer pessoa (canal telegram, token e acesso aberto): o chat oferece o link e o QR. */
  private telegramAberto(): boolean {
    const { config } = this.core;
    return config.channels.has('telegram') && Boolean(config.telegramBotToken) && config.telegramAccess.mode === 'aberto';
  }

  private telegramCache?: { link: string; qr: string; bot: string };

  /** Link https://t.me/<bot> (abre o app ou o Telegram Web) e o QR dele; o @ vem do Telegram (getMe) uma vez. */
  private async telegramLink(): Promise<{ link: string; qr: string; bot: string } | null> {
    if (!this.telegramAberto()) return null;
    if (!this.telegramCache) {
      const apiRoot = process.env.TELEGRAM_API_ROOT?.trim();
      const { username } = await new TelegramBotSetup(apiRoot ? { apiRoot } : {}).info(this.core.config.telegramBotToken);
      if (!username) return null;
      const link = `https://t.me/${username}`;
      this.telegramCache = { link, qr: await qrDataUrl(link), bot: username };
    }
    return this.telegramCache;
  }

  private conversations(userId: string) {
    return this.core.memory.listConversations(userId).map((c) => ({
      id: c.id,
      titulo: truncate(c.title.replace(/\s+/g, ' ').trim(), 80, '…') || 'Conversa vazia',
      ativa: c.isActive,
      mensagens: c.messageCount,
      atualizadaEm: c.updatedAt,
    }));
  }

  private history(userId: string, conversationId: string) {
    return this.core.memory.getHistory(userId, conversationId).map((m) => ({
      papel: m.role,
      texto: m.role === 'user' ? m.content.replace(/\n\n\[Documento anexado: ([^\]]+)\][\s\S]*$/, '\n\n📎 $1') : m.content,
      em: m.createdAt,
    }));
  }

  /** Uma mensagem por vez de cada visitante: o download longo de um não segura a conversa dos outros. */
  private enqueue<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(userId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    this.queues.set(userId, tail);
    void tail.then(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId);
    });
    return run;
  }

  /**
   * Quem está falando. Fora do modo público, o dono (WEB_USER_ID). No público, cada navegador manda um
   * identificador aleatório próprio (X-Visitante, guardado no próprio navegador): conversas, memória e anexos
   * ficam separados por visitante. O identificador vira hash, para não aparecer no banco.
   */
  private userIdFor(req: http.IncomingMessage): string {
    if (!this.options.public) return this.options.userId;
    const visitor = String(req.headers['x-visitante'] ?? '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(visitor)) throw new HttpError(400, 'Visitante não identificado; recarregue a página');
    return `${this.options.userId}-${createHash('sha256').update(visitor).digest('hex').slice(0, 16)}`;
  }

  /** Modo público: limita mensagens por hora, por visitante e no total (protege as chaves das LLMs). */
  private checkLimit(userId: string): void {
    const now = Date.now();
    const recent = (key: string) => (this.hits.get(key) ?? []).filter((at) => now - at < HOUR_MS);
    const mine = recent(userId);
    const all = recent('*');
    const limit = this.options.publicLimit ?? 20;
    const total = this.options.publicLimitTotal ?? 200;
    if (mine.length >= limit) throw new HttpError(429, `Limite de ${limit} mensagens por hora atingido; tente de novo mais tarde.`);
    if (all.length >= total) throw new HttpError(429, 'O agente atingiu o limite de uso desta hora; tente de novo mais tarde.');
    this.hits.set(userId, [...mine, now]);
    this.hits.set('*', [...all, now]);
    if (this.hits.size > 5000) for (const [key, times] of this.hits) if (!times.some((at) => now - at < HOUR_MS)) this.hits.delete(key);
  }

  private checkHost(req: http.IncomingMessage): void {
    if (this.options.host === '0.0.0.0' || this.options.host === '::') return;
    const port = this.address?.port ?? this.options.port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${this.options.host}:${port}`]);
    if (!allowed.has((req.headers.host ?? '').toLowerCase())) throw new HttpError(421, 'Host não permitido');
  }

  private checkToken(received: string | string[] | undefined): void {
    const value = Array.isArray(received) ? received[0] : received;
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(value ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Token inválido; abra o endereço exibido no terminal');
  }

  private async readJson(req: http.IncomingMessage): Promise<unknown> {
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Envie JSON');
    // Anexo em base64 ocupa ~4/3 do tamanho original.
    const limit = Math.ceil((this.core.config.maxDocumentBytes * 4) / 3) + 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Mensagem grande demais');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON inválido');
    }
  }

  /** Política da página: só o próprio K7, mais as origens que o painel da fita declarou (miniaturas, player). */
  private contentSecurityPolicy(nonce: string): string {
    const { images = [], frames = [] } = this.core.extensions.panel ?? {};
    return [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "media-src 'self' blob:",
      ['img-src', "'self'", 'data:', ...images].join(' '),
      ...(frames.length ? [['frame-src', ...frames].join(' ')] : []),
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }

  private sendPage(res: http.ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': this.contentSecurityPolicy(nonce),
    });
    res.end(renderPage(nonce, this.core.extensions.panel));
  }

  /** Rota de uma extensão: recebe os mesmos recursos que as rotas do tocador (visitante, mídia, .zip, fila). */
  private async runExtension(route: ExtensionRoute, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const userId = route.visitor ? this.userIdFor(req) : '';
    const header = req.headers['x-pedido'];
    if (req.method !== 'GET' && userId && PendingRequests.validId(header)) return this.runExtensionLater(route, req, res, url, userId, header);
    const ctx: WebRotaCtx = {
      req,
      res,
      url,
      params: route.path.exec(url.pathname)!.slice(1),
      userId,
      publico: this.options.public === true,
      saiu: WebChannel.whenClientLeaves(res),
      json: (data, status) => this.json(res, data, status),
      midia: (file, name) => this.sendMedia(req, res, file, name),
      zip: (entries, name) => this.writeZipResponse(res, entries, name),
      lerJson: () => this.readJson(req),
      falhar: (status, message) => {
        throw new HttpError(status, message);
      },
      emFila: (task) => this.enqueue(userId || 'x', task),
      progresso: (text, counts) => userId && ProgressBoard.set(userId, text, counts),
      limparProgresso: () => userId && ProgressBoard.clear(userId),
    };
    try {
      await route.handler(ctx);
    } catch (caught) {
      // Fechou a página no meio: ninguém mais espera a resposta.
      if (ctx.saiu.aborted && !(caught instanceof HttpError)) return;
      const error = fromExtension(caught);
      if (error instanceof UserFacingError) throw new HttpError(422, error.userMessage);
      throw error;
    }
  }

  /**
   * Rota da fita como pedido longo (X-Pedido): responde 202 na hora e roda a rota guardando o JSON que ela daria.
   * Só para rotas que respondem com ctx.json (as que escrevem direto em ctx.res, como nivelar um arquivo, não usam).
   * `saiu` dispara quando a página para de perguntar pela resposta (fechou a aba).
   */
  private async runExtensionLater(route: ExtensionRoute, req: http.IncomingMessage, res: http.ServerResponse, url: URL, userId: string, id: string): Promise<void> {
    if (this.pending.has(userId, id)) return this.json(res, { pedido: id }, 202);
    // O corpo é lido antes do 202: depois da resposta, a conexão pode ser reaproveitada e o corpo, descartado.
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    const body = hasBody ? await this.readJson(req) : undefined;
    const notHere = () => {
      throw new HttpError(400, 'Esta rota não responde como pedido longo');
    };
    this.pending.start(userId, id, async (abandoned) => {
      let answer: PendingResult = { status: 204, data: {} };
      const ctx: WebRotaCtx = {
        req,
        res,
        url,
        params: route.path.exec(url.pathname)!.slice(1),
        userId,
        publico: this.options.public === true,
        saiu: abandoned,
        json: (data, status) => void (answer = { status: status ?? 200, data }),
        midia: notHere,
        zip: async () => notHere(),
        lerJson: () => Promise.resolve(body ?? {}),
        falhar: (status, message) => {
          throw new HttpError(status, message);
        },
        emFila: (task) => this.enqueue(userId, task),
        progresso: (text, counts) => ProgressBoard.set(userId, text, counts),
        limparProgresso: () => ProgressBoard.clear(userId),
      };
      try {
        await route.handler(ctx);
        return answer;
      } catch (caught) {
        const error = fromExtension(caught);
        return this.errorResult(error instanceof UserFacingError ? new HttpError(422, error.userMessage) : error);
      }
    });
    this.json(res, { pedido: id }, 202);
  }

  /** Sinal que dispara se a conexão cair antes da resposta terminar (a pessoa fechou a página ou a aba). */
  private static whenClientLeaves(res: http.ServerResponse): AbortSignal {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  }

  /** Áudio/vídeo com suporte a Range: o tocador do navegador pula para qualquer ponto sem baixar tudo. */
  private sendMedia(req: http.IncomingMessage, res: http.ServerResponse, file: string, name: string): void {
    const size = fs.statSync(file).size;
    const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!range || (!range[1] && !range[2])) {
      res.writeHead(200, { ...headers, 'content-length': size });
      return void fs.createReadStream(file).pipe(res);
    }
    // "bytes=-500" = os últimos 500 bytes.
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return void res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  }

  private sendFile(res: http.ServerResponse, name: string): void {
    const file = this.output.filePath(name);
    if (!file) throw new HttpError(404, 'Arquivo não encontrado');
    const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': fs.statSync(file).size,
      'x-content-type-options': 'nosniff',
      'content-disposition': `${type.startsWith('audio/') || type.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    fs.createReadStream(file).pipe(res);
  }

  /** Todos os arquivos de uma resposta (ex.: playlist) num .zip, montado enquanto é enviado. */
  private async sendZip(res: http.ServerResponse, id: string, requestedName: string | null): Promise<void> {
    const entries = this.output.bundleEntries(id);
    if (!entries?.length) throw new HttpError(404, 'Pacote não encontrado');
    await this.writeZipResponse(res, entries, requestedName);
  }

  private async writeZipResponse(res: http.ServerResponse, entries: Array<{ name: string; path: string }>, requestedName: string | null): Promise<void> {
    let size: number;
    try {
      size = zipSize(entries);
    } catch (error) {
      if (error instanceof ZipTooLargeError) throw new HttpError(413, error.message);
      throw error;
    }
    const name = /^[\w .-]{1,80}\.zip$/.test(requestedName ?? '') ? requestedName! : 'downloads.zip';
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': size,
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    await writeZip(res, entries);
    res.end();
    this.logger.info(`📦 Pacote enviado: ${entries.length} arquivo(s), ${(size / 1024 / 1024).toFixed(1)} MB`);
  }

  private json(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
}
