import { AllProvidersFailedError, UserFacingError } from '../../errors/AppErrors.js';

/**
 * Aviso de erro para o usuário, igual em todos os canais. Nunca repassa stack traces ou
 * detalhes técnicos (que podem conter dados sensíveis) — apenas a mensagem amigável.
 */
export function formatUserError(error: unknown): string {
  if (error instanceof AllProvidersFailedError) return `⚠️ Erro: ${error.userMessage}`;
  if (error instanceof UserFacingError) return `⚠️ ${error.userMessage}`;
  return '⚠️ Erro: ocorreu uma falha interna ao processar sua mensagem. Veja os logs do terminal.';
}
