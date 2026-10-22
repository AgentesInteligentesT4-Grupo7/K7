// `\b` do JS não reconhece letras acentuadas ("áudio"), então usamos fronteiras Unicode.
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';
const AUDIO = `(?:áudio|audio|voz)${E}`;
const REPLY_VERBS = `${B}(?:respond[ae]r?|me\\s+respond[ae]|fal[ae]r?|mand[ae]r?|envi[ae]r?|grav[ae]r?|quero|prefiro)${E}`;

const rx = (source: string): RegExp => new RegExp(source, 'iu');

/** "responda em áudio", "me manda um áudio", "fale comigo", "por voz"... */
const POSITIVE: RegExp[] = [
  rx(`${REPLY_VERBS}[^.!?\\n]{0,30}?${B}(?:em|por|num|com|um|uma)\\s+${AUDIO}`),
  rx(`${B}fal[ae]\\s+comigo${E}`),
  rx(`${B}mensagem\\s+de\\s+voz${E}`),
  rx(`${B}resposta\\s+(?:em|por)\\s+${AUDIO}`),
];

/** "sem ser em áudio", "não precisa de áudio", "responda em texto"... */
const NEGATIVE: RegExp[] = [
  rx(`${B}(?:sem|não|nao|nunca|nada\\s+de)${E}[^.!?\\n]{0,25}?${B}${AUDIO}`),
  rx(`${REPLY_VERBS}[^.!?\\n]{0,30}?${B}(?:em|por)\\s+(?:texto|escrito)${E}`),
];

/**
 * Decide a flag `requires_audio_reply` (spec telegram-input RF-06 / EC-07):
 * - negação explícita sempre vence;
 * - voice note → true por padrão;
 * - texto → true apenas com pedido explícito por áudio.
 */
export class AudioIntentDetector {
  static resolve(text: string, isVoiceInput: boolean): boolean {
    if (AudioIntentDetector.isNegated(text)) return false;
    if (isVoiceInput) return true;
    return AudioIntentDetector.requestsAudio(text);
  }

  static requestsAudio(text: string): boolean {
    return POSITIVE.some((pattern) => pattern.test(text));
  }

  static isNegated(text: string): boolean {
    return NEGATIVE.some((pattern) => pattern.test(text));
  }
}
