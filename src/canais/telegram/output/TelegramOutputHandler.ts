import type { GeneratedImage } from '../../../agent/ResponseAttachments.js';
import type { AgentResponse, IOutputHandler } from '../../../agent/types.js';
import { BotBlockedError, UserFacingError, errorMessage } from '../../../errors/AppErrors.js';
import { Logger } from '../../../utils/Logger.js';
import { FileTagParser, type GeneratedFile } from '../../comum/FileTagParser.js';
import type { IOutputStrategy } from './strategies/OutputStrategy.js';
import type { IClonedVoiceProvider, ITextToSpeech, SynthesizedAudio } from '../../../voice/tts/TextToSpeech.js';
import { VoiceCloneTagParser } from '../../comum/VoiceCloneTagParser.js';
import { scriptMessage } from '../../../voice/SpeechDirection.js';

/** Strategy de áudio que aceita trocar o motor de TTS por chamada (ex.: voz clonada). */
export interface IAudioOutputStrategy {
  send(chatId: number, text: string, tts?: ITextToSpeech): Promise<void>;
}

export interface OutputStrategies {
  text: IOutputStrategy<string>;
  file: IOutputStrategy<GeneratedFile>;
  error: IOutputStrategy<unknown>;
  audio: IAudioOutputStrategy;
  /** Imagens geradas (módulo imagens); sem ela, as imagens são ignoradas. */
  image?: IOutputStrategy<GeneratedImage[]>;
}

/**
 * "Boca" do ParreiraClaw: escolhe a estratégia de entrega (texto em chunks,
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
      if (response.images?.length) await this.strategies.image?.send(chatId, response.images);
      for (const segment of cloned.segments) {
        await this.speakCloned(chatId, segment.text, segment.voice);
      }
      if (!text && files.length === 0 && cloned.segments.length === 0 && !response.images?.length) {
        await this.strategies.text.send(chatId, '(resposta vazia)');
      }
    });
  }

  /** Entrega um áudio já gerado (teste e ajuste da voz clonada) como voice note. */
  async sendPreparedVoice(chatId: number, text: string, audio: SynthesizedAudio): Promise<void> {
    await this.deliver(chatId, () => this.strategies.audio.send(chatId, text, { name: 'voz-clonada', voice: 'ajuste', synthesize: async () => audio }));
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
      const tts = this.clonedVoices.asTextToSpeech(voiceName);
      let script: string | undefined;
      await this.strategies.audio.send(chatId, text, {
        name: tts.name,
        voice: tts.voice,
        synthesize: async (speech) => {
          const audio = await tts.synthesize(speech);
          script = audio.script;
          return audio;
        },
      });
      if (script) await this.strategies.text.send(chatId, scriptMessage(script, tts.voice));
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
