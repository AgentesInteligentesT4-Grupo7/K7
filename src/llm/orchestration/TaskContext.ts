import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrivacyLevel, Task } from './types.js';

/**
 * Contexto da requisição atual, visível ao orquestrador sem mudar a assinatura de
 * `ILlmProvider.chat`. `pinned` fixa o modelo escolhido durante um ciclo do AgentLoop:
 * trocar de modelo no meio de tool calls quebra a continuidade (ex.: thought signatures do Gemini).
 */
export interface TaskContextValue {
  task: Task;
  privacy: PrivacyLevel;
  userId: string;
  pinned?: string;
}

const storage = new AsyncLocalStorage<TaskContextValue>();

export const TaskContext = {
  run<T>(value: TaskContextValue, fn: () => Promise<T>): Promise<T> {
    return storage.run(value, fn);
  },
  current(): TaskContextValue | undefined {
    return storage.getStore();
  },
};
