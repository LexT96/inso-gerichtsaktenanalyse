import '../../env'; // Load .env before importing config
import { describe, it, expect } from 'vitest';
import { chunk, runWithConcurrency } from '../extraction';

describe('chunk', () => {
  it('returns empty array for empty input', () => {
    expect(chunk([], 4)).toEqual([]);
  });
  it('returns single chunk when input shorter than size', () => {
    expect(chunk([1, 2], 4)).toEqual([[1, 2]]);
  });
  it('splits exact multiple', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  it('splits uneven, last chunk shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('throws on size <= 0', () => {
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});

describe('runWithConcurrency', () => {
  it('returns results in input order', async () => {
    const tasks = [10, 20, 30, 40].map(n => () => Promise.resolve(n * 2));
    const out = await runWithConcurrency(tasks, 2);
    expect(out).toEqual([
      { status: 'fulfilled', value: 20 },
      { status: 'fulfilled', value: 40 },
      { status: 'fulfilled', value: 60 },
      { status: 'fulfilled', value: 80 },
    ]);
  });

  it('captures rejections via allSettled semantics', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('c'),
    ];
    const out = await runWithConcurrency(tasks, 2);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(out[1].status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 'c' });
  });

  it('respects concurrency cap (max in-flight = limit)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const make = () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return 1;
    };
    const tasks = Array.from({ length: 6 }, make);
    await runWithConcurrency(tasks, 2);
    expect(maxInFlight).toBe(2);
  });
});
