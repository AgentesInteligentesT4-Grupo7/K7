import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentResponse, IOutputHandler } from '../../agent/types.js';
import { ModuleDisabledError, UserFacingError, errorMessage } from '../../errors/AppErrors.js';
import { stripMarkdown } from '../../utils/text.js';
import type { IClonedVoiceProvider, ITextToSpeech } from '../../voice/tts/TextToSpeech.js';
import { FileTagParser } from '../comum/FileTagParser.js';
import { formatUserError } from '../comum/formatUserError.js';
import { VoiceCloneTagParser } from '../comum/VoiceCloneTagParser.js';

/** Resposta de uma mensagem no canal web (JSON devolvido ao navegador). */
export interface WebReply {
  texto: string;
  arquivos: Array<{ nome: string; url: string }>;
  audios: Array<{ url: string; voz: string }>;
  imagens: Array<{ url: string; legenda?: string }>;
  avisos: string[];
  erro?: string;
  /** Mais de um áudio/vídeo na resposta (ex.: playlist): tudo de uma vez num .zip. */
  pacote?: { url: string; nome: string; quantidade: number };
}

export interface WebOutputOptions {
  /** Pasta onde documentos e áudios gerados ficam (servidos em /api/arquivos/<nome>). */
  outputDir: string;
  tts: ITextToSpeech;
  /** Ausente quando o módulo "voz-clonada" está desligado. */
  clonedVoices?: IClonedVoiceProvider;
}

/**
 * Saída do canal web: cada mensagem recebe um `chatId` próprio e espera a resposta do
 * AgentController aqui, que salva documentos/áudios e devolve tudo de uma vez.
 */
export class WebOutputHandler implements IOutputHandler {
  private readonly pending = new Map<number, (reply: WebReply) => void>();
  private nextChatId = 1;

  constructor(private readonly options: WebOutputOptions) {}

  /** Reserva um chatId para uma mensagem e devolve a promessa da resposta. */
  begin(): { chatId: number; reply: Promise<WebReply> } {
    const chatId = this.nextChatId++;
    const reply = new Promise<WebReply>((resolve) => this.pending.set(chatId, resolve));
    return { chatId, reply };
  }

  async send(chatId: number, response: AgentResponse): Promise<void> {
    const reply: WebReply = { texto: '', arquivos: [], audios: [], imagens: [], avisos: [] };
    const cloned = VoiceCloneTagParser.parse(response.text);
    const { text, files } = FileTagParser.parse(cloned.text);
    reply.texto = text;
    for (const file of files) {
      const name = this.save(file.filename, file.content);
      reply.arquivos.push({ nome: file.filename, url: WebOutputHandler.url(name) });
    }
    for (const image of response.images ?? []) {
      const name = this.save(path.basename(image.path), fs.readFileSync(image.path));
      reply.imagens.push({ url: WebOutputHandler.url(name), ...(image.caption ? { legenda: image.caption } : {}) });
    }
    const bundle: Array<{ nome: string; arquivo: string }> = [];
    for (const item of response.media ?? []) {
      const name = this.save(path.basename(item.path), item.path, true);
      reply.arquivos.push({ nome: path.basename(item.path), url: WebOutputHandler.url(name) });
      bundle.push({ nome: path.basename(item.path), arquivo: name });
    }
    if (bundle.length > 1) {
      const kind = response.media!.every((m) => m.kind === 'audio') ? 'musicas' : response.media!.every((m) => m.kind === 'video') ? 'videos' : 'arquivos';
      reply.pacote = { url: `/api/pacotes/${this.saveBundle(bundle)}`, nome: `${kind}.zip`, quantidade: bundle.length };
    }
    if (text && response.isAudio) await this.speak(reply, text, this.options.tts, 'resposta');
    for (const segment of cloned.segments) await this.speakCloned(reply, segment.text, segment.voice);
    this.resolve(chatId, reply);
  }

  async sendError(chatId: number, error: unknown): Promise<void> {
    this.resolve(chatId, { texto: '', arquivos: [], audios: [], imagens: [], avisos: [], erro: formatUserError(error) });
  }

  /** Gera um áudio avulso com a voz clonada (botão "falar" da página). */
  async speakClonedOnly(text: string, voiceName?: string): Promise<WebReply> {
    const reply: WebReply = { texto: '', arquivos: [], audios: [], imagens: [], avisos: [] };
    await this.speakCloned(reply, text, voiceName);
    return reply;
  }

  /** Caminho de um arquivo gerado, só pelo nome (nada fora da pasta de saída). */
  filePath(name: string): string | undefined {
    const base = path.basename(name);
    if (base !== name || base.startsWith('.')) return undefined;
    const full = path.join(this.options.outputDir, base);
    return fs.existsSync(full) ? full : undefined;
  }

  /** Arquivos de um pacote (nome bonito + caminho), para o .zip; `undefined` se o id não existir. */
  bundleEntries(id: string): Array<{ name: string; path: string }> | undefined {
    if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
    const manifest = path.join(this.options.outputDir, 'pacotes', `${id}.json`);
    if (!fs.existsSync(manifest)) return undefined;
    const items = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Array<{ nome: string; arquivo: string }>;
    return items.flatMap((item) => {
      const file = this.filePath(item.arquivo);
      return file ? [{ name: path.basename(item.nome), path: file }] : [];
    });
  }

  /** Guarda a lista do pacote com id aleatório (como os nomes dos arquivos, imprevisível). */
  private saveBundle(items: Array<{ nome: string; arquivo: string }>): string {
    const id = randomBytes(12).toString('hex');
    const dir = path.join(this.options.outputDir, 'pacotes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(items));
    return id;
  }

  private async speakCloned(reply: WebReply, text: string, voiceName?: string): Promise<void> {
    if (!this.options.clonedVoices) {
      reply.avisos.push(formatUserError(new ModuleDisabledError('voz-clonada', 'A voz clonada')));
      return;
    }
    try {
      const tts = this.options.clonedVoices.asTextToSpeech(voiceName);
      await this.speak(reply, text, tts, `voz-${tts.voice}`);
    } catch (error) {
      reply.avisos.push(`⚠️ Não consegui gerar com a voz clonada: ${error instanceof UserFacingError ? error.userMessage : errorMessage(error)}`);
    }
  }

  private async speak(reply: WebReply, text: string, tts: ITextToSpeech, label: string): Promise<void> {
    const speech = stripMarkdown(text);
    if (!speech) return;
    try {
      const { audio, format } = await tts.synthesize(speech);
      reply.audios.push({ url: WebOutputHandler.url(this.save(`${label}.${format}`, audio)), voz: tts.voice });
    } catch (error) {
      reply.avisos.push(`⚠️ Não consegui gerar o áudio: ${error instanceof UserFacingError ? error.userMessage : errorMessage(error)}`);
    }
  }

  private resolve(chatId: number, reply: WebReply): void {
    const resolve = this.pending.get(chatId);
    this.pending.delete(chatId);
    resolve?.(reply);
  }

  /**
   * `<data-hora>-<aleatório>-<nome>` na pasta de saída (nomes de <arquivo> já chegam sanitizados pelo FileTagParser).
   * A parte aleatória deixa o endereço imprevisível: no canal público, um visitante não acha o arquivo de outro.
   * `fromPath`: `content` é o caminho de um arquivo a copiar (vídeos grandes não passam pela memória).
   */
  private save(filename: string, content: string | Buffer, fromPath = false): string {
    fs.mkdirSync(this.options.outputDir, { recursive: true });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(8).toString('hex')}`;
    const safe = path.basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '-');
    let name = `${stamp}-${safe}`;
    for (let i = 2; fs.existsSync(path.join(this.options.outputDir, name)); i++) name = `${stamp}-${i}-${safe}`;
    if (fromPath) fs.copyFileSync(String(content), path.join(this.options.outputDir, name));
    else fs.writeFileSync(path.join(this.options.outputDir, name), content);
    return name;
  }

  private static url(name: string): string {
    return `/api/arquivos/${encodeURIComponent(name)}`;
  }
}
