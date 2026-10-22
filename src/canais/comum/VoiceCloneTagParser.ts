export interface ClonedVoiceSegment {
  /** Nome da voz (vazio = voz padrão). */
  voice: string | undefined;
  text: string;
}

const TAG = /<voz_clonada(?:\s+voz\s*=\s*["']([^"'\n]*)["'])?\s*>([\s\S]*?)<\/voz_clonada>/gi;

/**
 * Detecta `<voz_clonada voz="nome">texto</voz_clonada>` na resposta do LLM
 * (skill voz-clonada): cada trecho vira um voice note com a voz clonada.
 */
export class VoiceCloneTagParser {
  static parse(raw: string): { text: string; segments: ClonedVoiceSegment[] } {
    const segments: ClonedVoiceSegment[] = [];
    const text = raw.replace(TAG, (_match, voice: string | undefined, content: string) => {
      const spoken = content.trim();
      if (spoken) segments.push({ voice: voice?.trim() || undefined, text: spoken });
      return '';
    });
    return { text: text.replace(/\n{3,}/g, '\n\n').trim(), segments };
  }
}
