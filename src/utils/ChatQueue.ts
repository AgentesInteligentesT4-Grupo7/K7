import { Logger } from './Logger.js';

/**
 * Fila serial por chat. Permite que o handler do grammy retorne imediatamente
 * (o polling continua recebendo updates — RNF-01 Async IO), enquanto mensagens
 * de um mesmo chat são processadas em ordem, sem disputar a mesma conversa.
 */
export class ChatQueue {
  private readonly tails = new Map<number, Promise<void>>();
  private readonly logger = new Logger('ChatQueue');

  enqueue(chatId: number, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: unknown) => this.logger.error(`Tarefa do chat ${chatId} falhou sem tratamento`, error));
    this.tails.set(chatId, next);
    void next.finally(() => {
      if (this.tails.get(chatId) === next) this.tails.delete(chatId);
    });
    return next;
  }

  get size(): number {
    return this.tails.size;
  }
}
