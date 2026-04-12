/**
 * Global token-aware rate limiter for LLM API calls.
 *
 * Problem: Langdock has 200K TPM. A single extraction's Stage 2b fires
 * 3 parallel calls at ~70K tokens each (210K) — already over the limit.
 * With 2+ concurrent extractions, rate limits are guaranteed.
 *
 * Solution: Global semaphore that limits concurrent "heavy" API calls.
 * Heavy = estimated >50K input tokens (base extraction, focused passes).
 * Light calls (doc analysis, verification batches) skip the semaphore.
 *
 * The concurrency limit is computed from TPM: floor(TPM / 80K) = 2 for 200K TPM.
 * This ensures at most ~160K tokens in flight at any time.
 */

import { logger } from '../utils/logger';

const TPM_LIMIT = Number(process.env.LANGDOCK_TPM_LIMIT) || 200_000;
const TOKENS_PER_HEAVY_CALL = 80_000; // conservative estimate
const MAX_CONCURRENT_HEAVY = Math.max(1, Math.floor(TPM_LIMIT / TOKENS_PER_HEAVY_CALL));
const HEAVY_THRESHOLD = 50_000; // estimated input tokens above which a call is "heavy"
const CHARS_PER_TOKEN = 2.5; // German text estimate

let activeHeavyCalls = 0;
let activeExtractions = 0;
const waitQueue: Array<{ resolve: () => void }> = [];

function processQueue(): void {
  while (waitQueue.length > 0 && activeHeavyCalls < MAX_CONCURRENT_HEAVY) {
    const next = waitQueue.shift()!;
    activeHeavyCalls++;
    next.resolve();
  }
}

/**
 * Estimate input tokens from message content.
 */
export function estimateTokens(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === 'string') {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }
  // Array of content blocks
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      chars += block.text.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Acquire a slot for a heavy API call. Blocks if at concurrency limit.
 * Light calls (<50K estimated tokens) pass through immediately.
 */
export async function acquireSlot(estimatedTokens: number): Promise<void> {
  if (estimatedTokens < HEAVY_THRESHOLD) return; // light call, no throttling

  if (activeHeavyCalls < MAX_CONCURRENT_HEAVY) {
    activeHeavyCalls++;
    logger.debug('Rate limiter: heavy slot acquired', {
      active: activeHeavyCalls, max: MAX_CONCURRENT_HEAVY, queued: waitQueue.length,
    });
    return;
  }

  // Wait for a slot
  logger.info('Rate limiter: waiting for heavy slot', {
    active: activeHeavyCalls, max: MAX_CONCURRENT_HEAVY, queued: waitQueue.length,
    extractions: activeExtractions,
  });

  return new Promise(resolve => {
    waitQueue.push({ resolve });
  });
}

/**
 * Release a heavy call slot after the API call completes.
 */
export function releaseSlot(estimatedTokens: number): void {
  if (estimatedTokens < HEAVY_THRESHOLD) return;
  activeHeavyCalls = Math.max(0, activeHeavyCalls - 1);
  processQueue();
}

/**
 * Track active extractions (for logging/monitoring).
 */
export function registerExtraction(): () => void {
  activeExtractions++;
  logger.info('Rate limiter: extraction started', {
    activeExtractions, maxHeavyConcurrency: MAX_CONCURRENT_HEAVY,
  });
  return () => {
    activeExtractions = Math.max(0, activeExtractions - 1);
    logger.info('Rate limiter: extraction finished', { activeExtractions });
  };
}

/**
 * Get current rate limiter status (for monitoring/debugging).
 */
export function getRateLimiterStatus(): {
  activeExtractions: number;
  activeHeavyCalls: number;
  maxConcurrentHeavy: number;
  queuedCalls: number;
  tpmLimit: number;
} {
  return {
    activeExtractions,
    activeHeavyCalls,
    maxConcurrentHeavy: MAX_CONCURRENT_HEAVY,
    queuedCalls: waitQueue.length,
    tpmLimit: TPM_LIMIT,
  };
}
