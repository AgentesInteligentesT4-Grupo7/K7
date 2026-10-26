/**
 * Andamento de tarefas longas por usuário (ex.: download de uma playlist): a ferramenta escreve,
 * o canal mostra enquanto a resposta não chega. Some sozinho depois de 10 minutos sem atualização.
 */
const STALE_MS = 10 * 60_000;

export interface Progress {
  text: string;
  /** Itens concluídos e total, quando se sabe (a página desenha a barra de %). */
  done?: number;
  total?: number;
}

const board = new Map<string, Progress & { at: number }>();

export const ProgressBoard = {
  set(userId: string, text: string, counts?: { done: number; total: number }): void {
    board.set(userId, { text, ...(counts && counts.total > 0 ? counts : {}), at: Date.now() });
  },
  get(userId: string): Progress | undefined {
    const entry = board.get(userId);
    if (entry && Date.now() - entry.at < STALE_MS) {
      const { at: _at, ...progress } = entry;
      return progress;
    }
    board.delete(userId);
    return undefined;
  },
  clear(userId: string): void {
    board.delete(userId);
  },
};
