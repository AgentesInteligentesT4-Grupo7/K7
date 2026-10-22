import { ModuleDisabledError } from '../../errors/AppErrors.js';
import type { ISpeechToText } from './WhisperTranscriber.js';

/** Null Object do STT quando o módulo "voz" está desligado: recusa áudios com aviso amigável. */
export class DisabledSpeechToText implements ISpeechToText {
  async transcribe(): Promise<string> {
    throw new ModuleDisabledError('voz', 'Mensagens de voz');
  }
}
