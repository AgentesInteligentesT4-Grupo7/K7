import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentResponse, IOutputHandler } from '../agent/types.js';
import { UserFacingError, errorMessage } from '../errors/AppErrors.js';
import { FileTagParser } from '../telegram/output/FileTagParser.js';
import { ErrorOutputStrategy } from '../telegram/output/strategies/ErrorOutputStrategy.js';
import type { ITextToSpeech } from '../telegram/output/tts/TextToSpeech.js';
import { VoiceCloneTagParser } from '../telegram/output/VoiceCloneTagParser.js';
import type { IClonedVoiceProvider } from '../telegram/output/TelegramOutputHandler.js';
import { stripMarkdown } from '../utils/text.js';

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m' };

export interface TerminalOutputOptions {
  /** Onde documentos e áudios gerados são salvos (ex.: ./data/terminal). */
  outputDir: string;
  /** Abre os áudios no player padrão do Windows. */
  autoPlay: boolean;
  tts: ITextToSpeech;
  clonedVoices: IClonedVoiceProvider;
  write?: (text: string) => void;
  /** Rótulo das respostas, ex.: "🦀 AgroMinds" (vem da identidade do agente). */
  label?: string;
}

/**
 * Saída do canal terminal: texto no console; documentos (<arquivo>) e áudios
 * (resposta em voz ou voz clonada) viram arquivos locais com o caminho impresso.
 */
export class TerminalOutputHandler implements IOutputHandler {
  private readonly write: (text: string) => void;

  constructor(private readonly options: TerminalOutputOptions) {
    this.write = options.write ?? ((text) => process.stdout.write(text));
  }

  set autoPlay(value: boolean) {
    this.options.autoPlay = value;
  }

  get autoPlay(): boolean {
    return this.options.autoPlay;
  }

  async send(_chatId: number, response: AgentResponse): Promise<void> {
    const cloned = VoiceCloneTagParser.parse(response.text);
    const { text, files } = FileTagParser.parse(cloned.text);

    if (text) this.print(text);
    if (text && response.isAudio) await this.saveSpeech(text, this.options.tts, 'resposta');
    for (const file of files) {
      const target = this.uniquePath(file.filename);
      fs.writeFileSync(target, file.content, 'utf8');
      this.info(`📄 Documento salvo: ${target}`);
    }
    for (const segment of cloned.segments) await this.sendClonedVoice(0, segment.text, segment.voice);
    if (!text && files.length === 0 && cloned.segments.length === 0) this.print('(resposta vazia)');
  }

  async sendClonedVoice(_chatId: number, text: string, voiceName?: string): Promise<void> {
    let tts: ITextToSpeech;
    try {
      tts = this.options.clonedVoices.asTextToSpeech(voiceName);
    } catch (error) {
      this.warn(`⚠️ Não consegui gerar com a voz clonada: ${error instanceof UserFacingError ? error.userMessage : errorMessage(error)}`);
      return;
    }
    await this.saveSpeech(text, tts, `voz-${tts.voice}`);
  }

  async sendError(_chatId: number, error: unknown): Promise<void> {
    this.warn(ErrorOutputStrategy.format(error));
  }

  async notify(_chatId: number, text: string): Promise<void> {
    this.info(text);
  }

  private async saveSpeech(text: string, tts: ITextToSpeech, label: string): Promise<void> {
    const speech = stripMarkdown(text);
    if (!speech) return;
    try {
      this.info(`🔊 Gerando áudio (${tts.name}/${tts.voice})...`);
      const { audio, format } = await tts.synthesize(speech);
      const target = this.uniquePath(`${label}.${format}`);
      fs.writeFileSync(target, audio);
      this.info(`🔊 Áudio salvo: ${target}${this.options.autoPlay ? '' : '  (use /play para abrir automaticamente)'}`);
      if (this.options.autoPlay) TerminalOutputHandler.open(target);
    } catch (error) {
      this.warn(`⚠️ Não consegui gerar o áudio: ${error instanceof UserFacingError ? error.userMessage : errorMessage(error)}`);
    }
  }

  /** `<data-hora>-<nome>` na pasta de saída (nomes de <arquivo> já chegam sanitizados pelo FileTagParser). */
  private uniquePath(filename: string): string {
    fs.mkdirSync(this.options.outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = path.basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, '-');
    return path.join(this.options.outputDir, `${stamp}-${safe}`);
  }

  /** Abre o arquivo no aplicativo padrão (player de áudio, editor de Markdown). */
  static open(filePath: string): void {
    const [command, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${filePath}"`]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [filePath]];
    spawn(command as string, args as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  }

  private print(text: string): void {
    this.write(`\n${C.bold}${C.cyan}${this.options.label ?? '🦀 AgroMinds'}${C.reset}\n${text}\n\n`);
  }

  private info(text: string): void {
    this.write(`${C.green}${text}${C.reset}\n`);
  }

  private warn(text: string): void {
    this.write(`${C.yellow}${text}${C.reset}\n`);
  }
}
