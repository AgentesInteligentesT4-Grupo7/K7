import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyedLimiter, mapWithLimit } from '../src/utils/KeyedLimiter.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Paralelo com limite', () => {
  it('mapWithLimit: nunca passa do máximo, usa todas as vagas e devolve na ordem dos itens', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapWithLimit([5, 1, 4, 2, 3, 1, 2], 3, async (ms, i) => {
      peak = Math.max(peak, ++active);
      await wait(ms * 5);
      active--;
      return i * 10;
    });
    assert.equal(peak, 3);
    assert.deepEqual(result, [0, 10, 20, 30, 40, 50, 60]);
    assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
  });

  it('KeyedLimiter: cada chave tem as próprias vagas; quem passa do limite espera e depois roda', async () => {
    const limiter = new KeyedLimiter(2);
    const running = { ana: 0, beto: 0 };
    const peaks = { ana: 0, beto: 0 };
    const job = (who: 'ana' | 'beto') =>
      limiter.run(who, async () => {
        peaks[who] = Math.max(peaks[who], ++running[who]);
        await wait(10);
        running[who]--;
        return who;
      });
    const done = await Promise.all([job('ana'), job('ana'), job('ana'), job('ana'), job('beto'), job('beto')]);
    assert.equal(done.length, 6);
    assert.deepEqual(peaks, { ana: 2, beto: 2 });
    await assert.rejects(limiter.run('ana', async () => Promise.reject(new Error('falhou'))), /falhou/);
    assert.equal(await limiter.run('ana', async () => 'segue'), 'segue', 'uma falha libera a vaga');
  });
});
