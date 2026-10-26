/**
 * Andamento de tarefas longas por usuário (ex.: download de uma playlist): a ferramenta escreve,
 * o canal mostra enquanto a resposta não chega. Some sozinho depois de 10 minutos sem atualização.
 */
const STALE_MS = 10 * 60_000;
const board = new Map<string, { text: string; at: number }>();

export const ProgressBoard = {
  set(userId: string, text: string): void {
    board.set(userId, { text, at: Date.now() });
  },
  get(userId: string): string | undefined {
    const entry = board.get(userId);
    if (entry && Date.now() - entry.at < STALE_MS) return entry.text;
    board.delete(userId);
    return undefined;
  },
  clear(userId: string): void {
    board.delete(userId);
  },
};
