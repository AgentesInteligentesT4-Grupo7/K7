/**
 * Erro cuja mensagem pode ser exibida diretamente ao usuário no Telegram.
 * A mensagem técnica (`message`) fica restrita aos logs do terminal.
 */
export class UserFacingError extends Error {
  constructor(
    public readonly userMessage: string,
    technicalMessage?: string,
    options?: { cause?: unknown },
  ) {
    super(technicalMessage ?? userMessage, options);
    this.name = new.target.name;
  }
}

export class UnsupportedAttachmentError extends UserFacingError {
  constructor(detail: string) {
    super('No momento, só consigo processar texto estruturado (.md), áudio e PDF.', `Anexo não suportado: ${detail}`);
  }
}

export class FileTooLargeError extends UserFacingError {
  constructor(detail: string) {
    super('Esse arquivo excede limites locais suportados.', `Arquivo grande demais: ${detail}`);
  }
}

export class DownloadFailedError extends UserFacingError {
  constructor(detail: string, cause?: unknown) {
    super('Falha ao baixar arquivo do Telegram. Tente novamente.', `Download falhou: ${detail}`, { cause });
  }
}

export class WhisperUnavailableError extends UserFacingError {
  constructor(detail: string, cause?: unknown) {
    super('Não consegui inicializar o Whisper local agora.', `Whisper indisponível: ${detail}`, { cause });
  }
}

export class TranscriptionFailedError extends UserFacingError {
  constructor(detail: string, cause?: unknown) {
    super('Falha ao processar o áudio: arquivo grande demais ou falha no serviço.', `Transcrição falhou: ${detail}`, {
      cause,
    });
  }
}

export class EmptyAudioError extends UserFacingError {
  constructor() {
    super('Áudio vazio captado. Pode reenviar?', 'Whisper retornou transcrição vazia');
  }
}

export class DocumentParseError extends UserFacingError {
  constructor(detail: string, cause?: unknown) {
    super('Não consegui ler esse documento.', `Falha ao extrair documento: ${detail}`, { cause });
  }
}

/** Falha de um provider específico de LLM. Nunca carrega a API key. */
export class LlmProviderError extends Error {
  /** Falha temporária (429, 5xx, rede): vale tentar de novo. */
  readonly isTransient: boolean;
  /** Espera sugerida pelo servidor (header Retry-After). */
  readonly retryAfterMs: number | undefined;

  constructor(
    public readonly providerName: string,
    message: string,
    public readonly status?: number,
    options?: { cause?: unknown; transient?: boolean; retryAfterMs?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'LlmProviderError';
    this.isTransient = options?.transient ?? false;
    this.retryAfterMs = options?.retryAfterMs;
  }

  get isAuthError(): boolean {
    // O Gemini responde key inválida com 400 + "API key" em vez de 401.
    return this.status === 401 || this.status === 403 || (this.status === 400 && /api[ _-]?key/i.test(this.message));
  }
}

/** Todos os providers da cadeia (principal + fallbacks) falharam. */
export class AllProvidersFailedError extends UserFacingError {
  constructor(public readonly providerNames: string[], cause?: unknown) {
    const names = providerNames.join(', ');
    super(`API Provider ${names} falhou. Tente novamente em instantes.`, `Todos os providers falharam: ${names}`, {
      cause,
    });
  }
}

/** O AgentLoop estourou o teto de iterações (MAX_ITERATIONS). */
export class MaxIterationsError extends UserFacingError {
  constructor(public readonly maxIterations: number) {
    super(
      `Desculpe, desisti ou deu timeout no processamento pois falhei nas chamadas em ${maxIterations} iterações.`,
      `MAX_ITERATIONS (${maxIterations}) atingido`,
    );
  }
}

/** O usuário bloqueou o bot (HTTP 403 Forbidden). */
export class BotBlockedError extends Error {
  constructor(public readonly chatId: number) {
    super(`Chat ${chatId} bloqueou o bot`);
    this.name = 'BotBlockedError';
  }
}

/** Falha ao sintetizar áudio (TTS). */
export class AudioSynthesisError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AudioSynthesisError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
