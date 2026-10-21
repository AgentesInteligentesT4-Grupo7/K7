import fs from 'node:fs';
import path from 'node:path';
import type { AgentController } from '../agent/AgentController.js';
import type { AgentInput } from '../agent/types.js';
import { DocumentParseError, EmptyAudioError, UnsupportedAttachmentError, UserFacingError } from '../errors/AppErrors.js';
import type { OrchestratorCommands } from '../llm/orchestration/OrchestratorCommands.js';
import { AudioIntentDetector } from '../telegram/input/AudioIntentDetector.js';
import type { DocumentExtractor } from '../telegram/input/DocumentExtractor.js';
import type { ISpeechToText } from '../telegram/input/WhisperTranscriber.js';
import { Logger } from '../utils/Logger.js';
import { sanitizeText, truncate } from '../utils/text.js';
import type { VoiceCloneService } from '../voice/VoiceCloneService.js';
import type { TerminalOutputHandler } from './TerminalOutputHandler.js';

export interface TerminalChatDeps {
  controller: AgentController;
  output: TerminalOutputHandler;
  documents: DocumentExtractor;
  stt: ISpeechToText;
  voiceClone: VoiceCloneService;
  /** Conversa usada no SQLite ("terminal" ou o ID de um usuário do Telegram). */
  userId: string;
  voiceId: string;
  maxDocumentChars: number;
  write?: (text: string) => void;
  /** Presente com LLM_ORCHESTRATOR=on: /modelos, /modelo, /bom, /ruim. */
  orchestratorCommands?: OrchestratorCommands;
}

export const TERMINAL_HELP = [
  'Comandos:',
  '  /arquivo <caminho> [instrução]  envia um PDF ou .md (ex.: /arquivo "C:\\docs\\relatório.pdf" resuma)',
  '  /audio <caminho> [legenda]      transcreve um áudio e envia como mensagem de voz',
  '  /falar [@voz] <texto>           gera um áudio com a voz clonada',
  '  /vozes                          lista as vozes cadastradas',
  '  /nova                           inicia uma nova conversa',
  '  /skills                         lista as skills',
  '  /verbose                        mostra/esconde os passos do agente (Thought/Action/Observation)',
  '  /play                           abre os áudios gerados automaticamente no player',
  '  /modelos [tarefa]  /modelo      ranking dos modelos gratuitos / quem respondeu (orquestrador)',
  '  /bom  /ruim                     avalia a última resposta (ajusta o ranking)',
  '  /sair                           encerra',
].join('\n');

/** Canal terminal: cada linha digitada vira um AgentInput para o mesmo núcleo do Telegram. */
export class TerminalChat {
  private verbose = false;
  private readonly write: (text: string) => void;

  constructor(private readonly deps: TerminalChatDeps) {
    this.write = deps.write ?? ((text) => process.stdout.write(text));
  }

  /** Processa uma linha. Retorna `'exit'` quando o usuário pede para sair. */
  async handleLine(rawLine: string): Promise<'exit' | void> {
    const line = rawLine.trim();
    if (!line) return;
    const [command = '', ...restParts] = line.split(/\s+/);
    const rest = line.slice(command.length).trim();

    switch (command.toLowerCase()) {
      case '/sair':
      case '/exit':
      case '/quit':
        return 'exit';
      case '/ajuda':
      case '/help':
        return this.say(TERMINAL_HELP);
      case '/nova':
        this.deps.controller.newConversation(this.deps.userId);
        return this.say('🆕 Nova conversa iniciada.');
      case '/skills': {
        const skills = this.deps.controller.listSkills();
        return this.say(skills.length ? skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') : 'Nenhuma skill instalada.');
      }
      case '/vozes': {
        const voices = this.deps.voiceClone.list();
        return this.say(
          voices.length
            ? `${voices.map((v) => `- ${v.name}`).join('\n')}\nPasta: ${this.deps.voiceClone.voicesDir}`
            : `Nenhuma voz cadastrada. Coloque .wav/.mp3/.ogg em: ${this.deps.voiceClone.voicesDir}`,
        );
      }
      case '/falar': {
        const match = /^@(\S+)\s+([\s\S]+)$/.exec(rest);
        const text = (match ? match[2]! : rest).trim();
        if (!text) return this.say('Uso: /falar [@voz] <texto>');
        return this.deps.output.sendClonedVoice(0, text, match?.[1]);
      }
      case '/verbose':
        this.verbose = !this.verbose;
        Logger.setLevel(this.verbose ? 'info' : 'warn');
        return this.say(this.verbose ? '🔎 Passos do agente visíveis.' : '🔕 Passos do agente ocultos.');
      case '/play':
        this.deps.output.autoPlay = !this.deps.output.autoPlay;
        return this.say(this.deps.output.autoPlay ? '▶️ Áudios abrirão automaticamente.' : '⏹️ Áudios só serão salvos.');
      case '/modelos':
      case '/modelo':
      case '/bom':
      case '/ruim': {
        const commands = this.deps.orchestratorCommands;
        if (!commands) return this.say('O orquestrador está desligado (LLM_ORCHESTRATOR=off no .env).');
        const lower = command.toLowerCase();
        if (lower === '/modelos') return this.say(await commands.ranking(rest || undefined));
        if (lower === '/modelo') return this.say(commands.lastDecision(this.deps.userId));
        return this.say(commands.feedback(this.deps.userId, lower === '/bom' ? 1 : -1));
      }
      case '/arquivo':
        return this.withInput(() => this.documentInput(rest));
      case '/audio':
        return this.withInput(() => this.audioInput(rest));
      default:
        if (command.startsWith('/') && restParts.length === 0 && !line.includes(' ')) {
          return this.say(`Comando desconhecido: ${command}. Digite /ajuda.`);
        }
        return this.withInput(async () => {
          const requiresAudioReply = AudioIntentDetector.resolve(line, false);
          return this.input({ text: line, source: 'text', requiresAudioReply });
        });
    }
  }

  private async withInput(build: () => Promise<AgentInput>): Promise<void> {
    let input: AgentInput;
    try {
      input = await build();
    } catch (error) {
      await this.deps.output.sendError(0, error);
      return;
    }
    this.write('\x1b[2m⏳ pensando...\x1b[0m\n');
    await this.deps.controller.handle(input);
  }

  private async documentInput(rest: string): Promise<AgentInput> {
    const { filePath, remainder } = TerminalChat.parsePathArgument(rest);
    if (!filePath) throw new UserFacingError('Informe o caminho: /arquivo <caminho> [instrução]');
    const fileName = path.basename(filePath);
    const extractor = this.deps.documents.find(fileName, undefined);
    if (!extractor) throw new UnsupportedAttachmentError(fileName);
    TerminalChat.assertFile(filePath);

    let content: string;
    try {
      content = await extractor.extract(filePath);
    } catch (error) {
      throw new DocumentParseError(fileName, error);
    }
    content = truncate(sanitizeText(content).trim() || '[Documento sem texto extraível]', this.deps.maxDocumentChars);
    return this.input({
      text: `${remainder || 'Analise o documento anexado.'}\n\n[Documento anexado: ${fileName}]\n${content}`,
      source: 'document',
      requiresAudioReply: AudioIntentDetector.resolve(remainder, false),
      attachmentName: fileName,
    });
  }

  private async audioInput(rest: string): Promise<AgentInput> {
    const { filePath, remainder } = TerminalChat.parsePathArgument(rest);
    if (!filePath) throw new UserFacingError('Informe o caminho: /audio <caminho> [legenda]');
    TerminalChat.assertFile(filePath);
    this.write('\x1b[2m🎙️ transcrevendo...\x1b[0m\n');
    const transcript = await this.deps.stt.transcribe(filePath);
    if (!transcript) throw new EmptyAudioError();
    this.write(`\x1b[2m🎙️ "${transcript}"\x1b[0m\n`);
    const text = remainder ? `${remainder}\n\n${transcript}` : transcript;
    return this.input({ text, source: 'voice', requiresAudioReply: AudioIntentDetector.resolve(text, true) });
  }

  private input(partial: Pick<AgentInput, 'text' | 'source' | 'requiresAudioReply'> & Partial<AgentInput>): AgentInput {
    return {
      userId: this.deps.userId,
      chatId: 0,
      channel: 'terminal',
      ...(partial.requiresAudioReply ? { voiceId: this.deps.voiceId } : {}),
      ...partial,
    };
  }

  private say(text: string): void {
    this.write(`${text}\n`);
  }

  /** `"C:\pasta com espaço\a.pdf" resto` ou `C:\a.pdf resto`. */
  static parsePathArgument(rest: string): { filePath: string; remainder: string } {
    const quoted = /^["']([^"']+)["']\s*([\s\S]*)$/.exec(rest);
    if (quoted) return { filePath: quoted[1]!, remainder: quoted[2]!.trim() };
    const [filePath = '', ...remainder] = rest.split(/\s+/);
    return { filePath, remainder: remainder.join(' ').trim() };
  }

  private static assertFile(filePath: string): void {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new UserFacingError(`Arquivo não encontrado: ${filePath}`);
    }
  }
}
