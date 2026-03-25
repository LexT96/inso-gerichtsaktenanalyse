/**
 * Generic parallel execution with concurrency control.
 *
 * Runs async tasks in parallel, limiting the number of concurrent
 * tasks to avoid overwhelming API rate limits.
 */

/**
 * Execute tasks in parallel with a concurrency limit.
 * Results are returned in the same order as the input tasks.
 *
 * On task failure: the error propagates immediately and remaining tasks
 * are abandoned. Callers should handle errors at the task level if they
 * want partial results.
 */
export async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  if (tasks.length === 0) return [];

  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      results[idx] = await tasks[idx]();
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Like parallelLimit but collects errors per task instead of failing fast.
 * Returns { results, errors } where errors[i] is set if task i failed.
 */
export async function parallelLimitSettled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<{ results: (T | undefined)[]; errors: (Error | undefined)[] }> {
  if (tasks.length === 0) return { results: [], errors: [] };

  const results: (T | undefined)[] = new Array(tasks.length);
  const errors: (Error | undefined)[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        errors[idx] = err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { results, errors };
}
