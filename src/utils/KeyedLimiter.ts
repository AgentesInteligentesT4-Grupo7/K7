/**
 * No máximo `max` tarefas ao mesmo tempo por chave (ex.: por visitante); as demais esperam a vez, na ordem.
 * Usado no nivelamento de volume: várias músicas em paralelo, sem uma pessoa ocupar o serviço inteiro.
 */
export class KeyedLimiter {
  private readonly slots = new Map<string, { active: number; waiting: Array<() => void> }>();

  constructor(private readonly max: number) {}

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const slot = this.slots.get(key) ?? { active: 0, waiting: [] };
    this.slots.set(key, slot);
    if (slot.active >= this.max) await new Promise<void>((resolve) => slot.waiting.push(resolve));
    slot.active++;
    try {
      return await task();
    } finally {
      slot.active--;
      const next = slot.waiting.shift();
      if (next) next();
      else if (slot.active === 0) this.slots.delete(key);
    }
  }
}

/** Roda `task` para cada item com até `max` ao mesmo tempo; o resultado sai na ordem dos itens. */
export async function mapWithLimit<T, R>(items: T[], max: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, max), items.length) }, worker));
  return results;
}
