import type { AgentResponse, IOutputHandler } from '../../agent/types.js';
import { BotBlockedError, UserFacingError, errorMessage } from '../../errors/AppErrors.js';
import { Logger } from '../../utils/Logger.js';
import { FileTagParser, type GeneratedFile } from './FileTagParser.js';
import type { IOutputStrategy } from './strategies/OutputStrategy.js';
import type { ITextToSpeech } from './tts/TextToSpeech.js';
import { VoiceCloneTagParser } from './VoiceCloneTagParser.js';

/** Strategy de áudio que aceita trocar o motor de TTS por chamada (ex.: voz clonada). */
export interface IAudioOutputStrategy {
  send(chatId: number, text: string, tts?: ITextToSpeech): Promise<void>;
}

/** Fornece um TTS com a voz clonada escolhida (VoiceCloneService). */
export interface IClonedVoiceProvider {
  asTextToSpeech(voiceName?: string): ITextToSpeech;
}

export interface OutputStrategies {
  text: IOutputStrategy<string>;
  file: IOutputStrategy<GeneratedFile>;
  error: IOutputStrategy<unknown>;
  audio: IAudioOutputStrategy;
}

/**
 * "Boca" do AgroMinds: escolhe a estratégia de entrega (texto em chunks,
 * documento .md, voz, voz clonada ou aviso de erro) para o resultado final da pipeline.
 */
export class TelegramOutputHandler implements IOutputHandler {
  private readonly logger = new Logger('Output');

  constructor(
    private readonly strategies: OutputStrategies,
    private readonly clonedVoices?: IClonedVoiceProvider,
  ) {}

  async send(chatId: number, response: AgentResponse): Promise<void> {
    await this.deliver(chatId, async () => {
      const cloned = VoiceCloneTagParser.parse(response.text);
      const { text, files } = FileTagParser.parse(cloned.text);

      if (text) {
        if (response.isAudio) await this.sendAudioWithFallback(chatId, text);
        else await this.strategies.text.send(chatId, text);
      }
      for (const file of files) {
        await this.strategies.file.send(chatId, file);
      }
      for (const segment of cloned.segments) {
        await this.speakCloned(chatId, segment.text, segment.voice);
      }
      if (!text && files.length === 0 && cloned.segments.length === 0) {
        await this.strategies.text.send(chatId, '(resposta vazia)');
      }
    });
  }

  /** Fala exatamente `text` com a voz clonada (comando /falar). */
  async sendClonedVoice(chatId: number, text: string, voiceName?: string): Promise<void> {
    await this.deliver(chatId, () => this.speakCloned(chatId, text, voiceName));
  }

  async sendError(chatId: number, error: unknown): Promise<void> {
    await this.deliver(chatId, () => this.strategies.error.send(chatId, error));
  }

  /** Mensagem informativa simples (comandos, avisos do input). */
  async notify(chatId: number, text: string): Promise<void> {
    await this.deliver(chatId, () => this.strategies.text.send(chatId, text));
  }

  private async speakCloned(chatId: number, text: string, voiceName?: string): Promise<void> {
    if (!this.clonedVoices) {
      await this.strategies.text.send(chatId, '⚠️ A clonagem de voz não está configurada.');
      return;
    }
    try {
      await this.strategies.audio.send(chatId, text, this.clonedVoices.asTextToSpeech(voiceName));
    } catch (error) {
      if (error instanceof BotBlockedError) throw error;
      this.logger.warn(`Falha na voz clonada: ${errorMessage(error)}`);
      const reason = error instanceof UserFacingError ? error.userMessage : 'o serviço de clonagem (Chatterbox) falhou ou está desligado.';
      await this.strategies.text.send(chatId, `⚠️ Não consegui gerar com a voz clonada: ${reason}`);
    }
  }

  private async sendAudioWithFallback(chatId: number, text: string): Promise<void> {
    try {
      await this.strategies.audio.send(chatId, text);
    } catch (error) {
      if (error instanceof BotBlockedError) throw error;
      this.logger.warn(`Falha no áudio, fallback para texto: ${errorMessage(error)}`);
      await this.strategies.text.send(chatId, `⚠️ Não consegui gerar o áudio, segue em texto:\n\n${text}`);
    }
  }

  /** Nenhuma falha de entrega derruba a stack do Node. */
  private async deliver(chatId: number, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof BotBlockedError) {
        this.logger.warn(`Msg abandonada, User bot-blocked (chat ${chatId})`);
        return;
      }
      this.logger.error(`Falha ao entregar mensagem no chat ${chatId}: ${errorMessage(error)}`);
    }
  }
}
