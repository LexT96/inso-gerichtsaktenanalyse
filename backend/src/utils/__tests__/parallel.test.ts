import { describe, it, expect } from 'vitest';
import { parallelLimit, parallelLimitSettled } from '../parallel';

describe('parallelLimit', () => {
  it('executes tasks and returns results in order', async () => {
    const results = await parallelLimit([
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ], 2);

    expect(results).toEqual([1, 2, 3]);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const makeTask = (value: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 10));
      running--;
      return value;
    };

    await parallelLimit([
      makeTask(1), makeTask(2), makeTask(3), makeTask(4), makeTask(5),
    ], 2);

    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('handles empty task list', async () => {
    const results = await parallelLimit([], 3);
    expect(results).toEqual([]);
  });

  it('handles single task', async () => {
    const results = await parallelLimit([() => Promise.resolve(42)], 3);
    expect(results).toEqual([42]);
  });
});

describe('parallelLimitSettled', () => {
  it('collects errors per task without failing fast', async () => {
    const { results, errors } = await parallelLimitSettled([
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('fail')),
      () => Promise.resolve('also ok'),
    ], 3);

    expect(results[0]).toBe('ok');
    expect(results[2]).toBe('also ok');
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toBeInstanceOf(Error);
    expect(errors[1]!.message).toBe('fail');
    expect(errors[2]).toBeUndefined();
  });

  it('handles all tasks succeeding', async () => {
    const { results, errors } = await parallelLimitSettled([
      () => Promise.resolve(1),
      () => Promise.resolve(2),
    ], 2);

    expect(results).toEqual([1, 2]);
    expect(errors.every(e => e === undefined)).toBe(true);
  });

  it('handles all tasks failing', async () => {
    const { results, errors } = await parallelLimitSettled([
      () => Promise.reject(new Error('a')),
      () => Promise.reject(new Error('b')),
    ], 2);

    expect(results.every(r => r === undefined)).toBe(true);
    expect(errors[0]!.message).toBe('a');
    expect(errors[1]!.message).toBe('b');
  });
});
