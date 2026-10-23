import fs from 'node:fs';
import path from 'node:path';
import type { AgentController } from '../../agent/AgentController.js';
import type { AgentInput } from '../../agent/types.js';
import { DocumentParseError, EmptyAudioError, ModuleDisabledError, UnsupportedAttachmentError, UserFacingError } from '../../errors/AppErrors.js';
import type { OrchestratorCommands } from '../../llm/orchestration/OrchestratorCommands.js';
import { AttachmentService } from '../../modules/anexos/AttachmentService.js';
import { AudioIntentDetector } from '../../voice/AudioIntentDetector.js';
import type { DocumentExtractor } from '../../documents/DocumentExtractor.js';
import type { ISpeechToText } from '../../voice/stt/WhisperTranscriber.js';
import { Logger } from '../../utils/Logger.js';
import { sanitizeText, truncate } from '../../utils/text.js';
import type { VoiceCloneService } from '../../voice/VoiceCloneService.js';
import type { VoiceTuner } from '../../voice/VoiceTuner.js';
import type { TerminalOutputHandler } from './TerminalOutputHandler.js';
import { DIRECTION_HELP } from '../../voice/SpeechDirection.js';

export interface TerminalChatDeps {
  controller: AgentController;
  output: TerminalOutputHandler;
  documents: DocumentExtractor;
  stt: ISpeechToText;
  /** Ausente quando o módulo "voz-clonada" está desligado. */
  voiceClone?: VoiceCloneService;
  /** /testarvoz, /ajustar, /salvarvoz (exige voz-clonada e voz). */
  voiceTuner?: VoiceTuner;
  /** Conversa usada no SQLite ("terminal" ou o ID de um usuário do Telegram). */
  userId: string;
  voiceId: string;
  maxDocumentChars: number;
  write?: (text: string) => void;
  /** Módulo anexos: /imagem, /anexos e /arquivo passando pela biblioteca. */
  attachments?: AttachmentService;
  /** Presente com LLM_ORCHESTRATOR=on: /modelos, /modelo, /bom, /ruim. */
  orchestratorCommands?: OrchestratorCommands;
}

export const TERMINAL_HELP = [
  'Comandos:',
  '  /arquivo <caminho> [instrução]  envia um PDF ou .md (ex.: /arquivo "C:\\docs\\relatório.pdf" resuma)',
  '  /imagem <caminho> [pergunta]    envia uma imagem (print, foto, recibo) para o agente olhar',
  '  /anexos                         lista as imagens e documentos guardados',
  '  /audio <caminho> [legenda]      transcreve um áudio e envia como mensagem de voz',
  '  /falar [@voz] <texto>           gera um áudio com a voz clonada',
  '  /vozes   /apagarvoz <nome>      lista as vozes cadastradas / apaga uma',
  '  /testarvoz [@voz] <arquivo>     transcreve o áudio e fala de novo com a voz clonada, para comparar',
  '  /ajustar <pedido>  /salvarvoz   refaz o último teste ou /falar (mais emoção, igualar...) / guarda',
  '  /nova                           inicia uma nova conversa',
  '  /skills                         lista as skills',
  '  /memoria   /esquecer <n>|tudo   o que o agente lembra (resumo e fatos) / apagar',
  '  /persona [nome|sair]            fala com uma persona (memória própria); ou "@nome mensagem"',
  '  /estilo [nome|padrao] [n=N]     tom do texto e níveis 1–10 (ex.: /estilo formal detalhe=3)',
  '  /modo [normal|reformular|verificado]  raciocínio (verificado confere os fatos)',
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
        const { voiceClone } = this.deps;
        if (!voiceClone) return this.deps.output.sendError(0, new ModuleDisabledError('voz-clonada', 'A clonagem de voz'));
        const voices = voiceClone.list();
        return this.say(
          voices.length
            ? `${voices.map((v) => `- ${v.name}`).join('\n')}\nPasta: ${voiceClone.voicesDir}`
            : `Nenhuma voz cadastrada. Coloque .wav/.mp3/.ogg em: ${voiceClone.voicesDir}`,
        );
      }
      case '/testarvoz':
      case '/ajustar':
      case '/salvarvoz':
        return this.voiceTuning(command, rest);
      case '/apagarvoz': {
        const { voiceClone } = this.deps;
        if (!voiceClone) return this.deps.output.sendError(0, new ModuleDisabledError('voz-clonada', 'A clonagem de voz'));
        if (!rest.trim()) return this.say('Uso: /apagarvoz <nome>');
        try {
          return this.say(voiceClone.remove(rest.trim().replace(/^@/, '')));
        } catch (error) {
          return this.deps.output.sendError(0, error);
        }
      }
      case '/falar': {
        const match = /^@(\S+)\s+([\s\S]+)$/.exec(rest);
        const text = (match ? match[2]! : rest).trim();
        if (!text) return this.say(`Uso: /falar [@voz] <texto>\n${DIRECTION_HELP}`);
        try {
          this.deps.voiceTuner?.remember(`terminal:${this.deps.userId}`, text, match?.[1]);
        } catch {
          // Voz inexistente: o /falar abaixo mostra o erro amigável.
        }
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
      case '/persona':
        return this.say(this.deps.controller.personaCommand(this.deps.userId, rest));
      case '/estilo':
        return this.say(this.deps.controller.styleCommand(this.deps.userId, rest));
      case '/modo':
        return this.say(this.deps.controller.modeCommand(this.deps.userId, rest));
      case '/memoria':
        return this.say(this.deps.controller.memoryReport(this.deps.userId));
      case '/esquecer':
        return this.say(this.deps.controller.forget(this.deps.userId, rest));
      case '/imagem':
        return this.withInput(() => this.attachmentInput(rest));
      case '/anexos': {
        const { attachments } = this.deps;
        if (!attachments) return this.deps.output.sendError(0, new ModuleDisabledError('anexos', 'A biblioteca de anexos'));
        const items = attachments.store.list(this.deps.userId, { limit: 20 });
        return this.say(items.length ? items.map((a) => `#${a.id} · ${a.name} · ${a.kind} · ${a.createdAt.slice(0, 16)}`).join('\n') : 'Nenhum anexo guardado.');
      }
      case '/arquivo':
        if (this.deps.attachments) return this.withInput(() => this.attachmentInput(rest));
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

  /** /testarvoz [@voz] <arquivo>, /ajustar <pedido>, /salvarvoz [nome]: mesma lógica do Telegram (VoiceTuner). */
  private async voiceTuning(command: string, rest: string): Promise<void> {
    const { voiceTuner, output } = this.deps;
    if (!voiceTuner) return output.sendError(0, new ModuleDisabledError('voz', 'O teste de voz (precisa de voz e voz-clonada)'));
    const key = `terminal:${this.deps.userId}`;
    try {
      if (command === '/salvarvoz') return this.say(voiceTuner.save(key, rest.trim().replace(/^@/, '') || undefined));
      if (command === '/ajustar') {
        const { audio, report } = await voiceTuner.adjust(key, rest);
        await output.sendPreparedVoice(0, 'ajuste', audio, 'ajuste-voz');
        return this.say(report);
      }
      const voiceMatch = /^@(\S+)\s+/.exec(rest);
      const { filePath } = TerminalChat.parsePathArgument(voiceMatch ? rest.slice(voiceMatch[0].length) : rest);
      if (!filePath) return this.say('Uso: /testarvoz [@voz] <caminho do áudio>  (ex.: /testarvoz @minha-voz "C:\\Downloads\\audio.opus")');
      TerminalChat.assertFile(filePath);
      this.say('🧪 Transcrevendo e gerando de novo... (leva alguns segundos)');
      const { audio, report } = await voiceTuner.test(key, filePath, path.extname(filePath), voiceMatch?.[1]);
      await output.sendPreparedVoice(0, 'teste', audio, 'teste-voz');
      return this.say(report);
    } catch (error) {
      return output.sendError(0, error);
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

  /** Imagem ou documento pela biblioteca de anexos (referência + trecho, imagem para visão). */
  private async attachmentInput(rest: string): Promise<AgentInput> {
    const { attachments } = this.deps;
    if (!attachments) throw new ModuleDisabledError('anexos', 'Imagens');
    const { filePath, remainder } = TerminalChat.parsePathArgument(rest);
    if (!filePath) throw new UserFacingError('Informe o caminho: /imagem <caminho> [pergunta]');
    TerminalChat.assertFile(filePath);
    const name = path.basename(filePath);
    if (!AttachmentService.supports(name)) throw new UnsupportedAttachmentError(name);
    const item = await attachments.ingest({ userId: this.deps.userId, name, mime: '', data: fs.readFileSync(filePath), caption: remainder });
    const built = attachments.buildInput([item], remainder);
    return this.input({
      text: built.text,
      source: built.images.length ? 'image' : 'document',
      requiresAudioReply: AudioIntentDetector.resolve(remainder, false),
      attachmentName: built.attachmentName,
      ...(built.images.length ? { images: built.images } : {}),
    });
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
