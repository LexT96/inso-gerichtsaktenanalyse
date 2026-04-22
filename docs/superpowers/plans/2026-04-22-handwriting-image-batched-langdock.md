# Image-batched Handwriting Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third mode `image-batched` to Stage 3c handwriting extraction so production (Langdock, no native PDF) actually recognizes handwritten Fragebogen values via Claude Vision instead of degrading to useless Azure DI text mode.

**Architecture:** New mode renders Fragebogen pages as JPEG via existing `renderPagesToJpeg(dpi=150)`, batches to 4 pages, runs max 2 batches concurrently via inline worker pool with `Promise.allSettled`. Each batch labels every image with `=== SEITE X ===` so Claude attributes `quelle` correctly. Reuses existing `HANDWRITING_PROMPT`, `mergeField`, skipped-logging from PR #17. Provider routing via existing `anthropicSupportsNativePdf()` (PR #17).

**Tech Stack:** TypeScript, vitest, pymupdf (already wired), Anthropic SDK via Langdock proxy.

**Spec:** `docs/superpowers/specs/2026-04-22-handwriting-image-batched-langdock-design.md`

---

## File Map

- **Modify**: `backend/src/services/extraction.ts` — add `chunk()`, `runWithConcurrency()` helpers, refactor `extractHandwriting` to dispatch via three modes, add `extractHandwritingImageBatched()`, optional OCR-layer-annotation collection.
- **Modify**: `backend/src/services/extractionProvider.ts` — already has `anthropicSupportsNativePdf` (PR #17); no change needed.
- **Modify**: `backend/src/utils/pageImageRenderer.ts` — already exports `renderPagesToJpeg(pdfBuffer, pages, dpi)`; no change needed.
- **Optional modify**: `backend/src/services/ocrService.ts` — only if OCR-layer integration is included; add helper to inject synthetic word entries.
- **Optional modify**: extraction.ts main pipeline — re-run `addOcrTextLayer` after handwriting if synthetic entries were added.
- **Create**: `backend/src/services/__tests__/extraction.handwriting-batched.test.ts` — vitest unit tests for chunk, concurrency, and image-batched control flow with mocked `createAnthropicMessage`.

---

## Task 1: Pure helper `chunk(arr, size)`

**Files:**
- Modify: `backend/src/services/extraction.ts` (add helper near other utilities, e.g. after `FRAGEBOGEN_MARKERS`)
- Test: `backend/src/services/__tests__/extraction.handwriting-batched.test.ts` (new)

- [ ] **Step 1: Write failing tests**

```ts
// backend/src/services/__tests__/extraction.handwriting-batched.test.ts
import { describe, it, expect } from 'vitest';
import { chunk } from '../extraction';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/__tests__/extraction.handwriting-batched.test.ts`
Expected: FAIL — `chunk` not exported from `../extraction`.

- [ ] **Step 3: Implement `chunk` in extraction.ts**

Add near the top of `backend/src/services/extraction.ts`, after the imports / before `FRAGEBOGEN_MARKERS`:

```ts
/** Split an array into consecutive groups of at most `size` elements. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/__tests__/extraction.handwriting-batched.test.ts`
Expected: PASS — 5/5 chunk tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/extraction.ts backend/src/services/__tests__/extraction.handwriting-batched.test.ts
git commit -m "feat(handwriting): add chunk helper for batching pages"
```

---

## Task 2: Concurrency-gated runner

**Files:**
- Modify: `backend/src/services/extraction.ts` (add `runWithConcurrency` near `chunk`)
- Test: `backend/src/services/__tests__/extraction.handwriting-batched.test.ts`

- [ ] **Step 1: Write failing tests**

Append to the existing test file:

```ts
import { runWithConcurrency } from '../extraction';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/__tests__/extraction.handwriting-batched.test.ts`
Expected: FAIL — `runWithConcurrency` not exported.

- [ ] **Step 3: Implement `runWithConcurrency` in extraction.ts**

Add right after the `chunk` helper:

```ts
/**
 * Run async tasks with at most `concurrency` running in parallel.
 * Returns settled results in input order (Promise.allSettled semantics).
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  if (concurrency <= 0) throw new Error('concurrency must be > 0');
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/__tests__/extraction.handwriting-batched.test.ts`
Expected: PASS — chunk + runWithConcurrency tests all green (8 total).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/extraction.ts backend/src/services/__tests__/extraction.handwriting-batched.test.ts
git commit -m "feat(handwriting): add runWithConcurrency worker pool helper"
```

---

## Task 3: Extract single-batch image call into helper

This isolates the LLM-call logic for one batch so the multi-batch loop in Task 4 stays small.

**Files:**
- Modify: `backend/src/services/extraction.ts` (add private function after `extractPzuZustellungsdatum` and before `extractHandwriting`)

- [ ] **Step 1: Add new helper `callHandwritingBatch`**

Insert this function before `export async function extractHandwriting(`:

```ts
/**
 * Send one batch of Fragebogen pages as JPEG images to Claude Vision via the
 * configured Anthropic backend (works on Langdock since it accepts type:'image').
 * Returns the parsed handwriting JSON for this batch, or null if the batch
 * failed (network, parse error, all-empty response).
 */
async function callHandwritingBatch(
  batchPages: number[],
  imagesByPage: Map<number, string>,
  promptSuffix: string,
  cacheable: boolean,
): Promise<Record<string, { wert: unknown; quelle: string }> | null> {
  const content: Array<
    | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } }
  > = [];
  for (const p of batchPages) {
    const b64 = imagesByPage.get(p);
    if (!b64) continue; // page render failed earlier; skip
    content.push({ type: 'text', text: `=== SEITE ${p + 1} ===` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  }
  if (content.length === 0) return null;

  // Final prompt block — cache_control on the static portion lets Anthropic
  // reuse it across the other batches (5 min TTL → 90% input savings)
  const finalText: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } } = {
    type: 'text',
    text: `${HANDWRITING_PROMPT}${promptSuffix}`,
  };
  if (cacheable) finalText.cache_control = { type: 'ephemeral' };
  content.push(finalText);

  let response;
  try {
    response = await callWithRetry(() => createAnthropicMessage({
      model: config.EXTRACTION_MODEL,
      max_tokens: 8192,
      temperature: 0,
      messages: [{ role: 'user' as const, content: content as never }],
    }));
  } catch (err) {
    logger.warn('Handwriting batch call failed', {
      pages: batchPages.map(p => p + 1),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (response.stop_reason === 'max_tokens') {
    logger.warn('Handwriting batch hit max_tokens, output may be truncated', {
      pages: batchPages.map(p => p + 1),
    });
  }

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');

  try {
    const jsonStr = extractJsonFromText(text);
    try {
      return JSON.parse(jsonStr) as Record<string, { wert: unknown; quelle: string }>;
    } catch {
      const { jsonrepair } = await import('jsonrepair');
      const parsed = JSON.parse(jsonrepair(jsonStr)) as Record<string, { wert: unknown; quelle: string }>;
      logger.info('Handwriting batch JSON per jsonrepair repariert', {
        pages: batchPages.map(p => p + 1),
      });
      return parsed;
    }
  } catch (err) {
    logger.warn('Handwriting batch JSON parse failed', {
      pages: batchPages.map(p => p + 1),
      error: err instanceof Error ? err.message : String(err),
      sample: text.slice(0, 300),
    });
    return null;
  }
}
```

- [ ] **Step 2: Verify backend tsc clean**

Run: `cd backend && npx tsc --noEmit`
Expected: EXIT 0 (helper compiles, used in Task 4).

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/extraction.ts
git commit -m "feat(handwriting): add callHandwritingBatch helper for image-mode batches"
```

---

## Task 4: Wire image-batched mode into `extractHandwriting`

**Files:**
- Modify: `backend/src/services/extraction.ts` — change the existing if/else at the top of `extractHandwriting` to a 3-way branch.

- [ ] **Step 1: Update imports at top of extraction.ts**

If not already imported, ensure `anthropicSupportsNativePdf` is in the import line from `./extractionProvider`. PR #17 already added this — verify by reading line 4 of `backend/src/services/extraction.ts`. If missing, add it.

- [ ] **Step 2: Locate the existing 2-way branch in `extractHandwriting`**

Find this block (around line 491-529 — the `if (pdfBuffer && supportsNativePdf...) ... else { text mode }`):

```ts
  let response;
  if (pdfBuffer && anthropicSupportsNativePdf()) {
    // Native PDF mode: send mini-PDF for vision-based handwriting OCR
    const miniPdf = await extractPdfPages(pdfBuffer, formPages);
    const base64 = miniPdf.toString('base64');
    response = await callWithRetry(() => createAnthropicMessage({ ... }));
  } else {
    // Text mode (Langdock): send OCR text of form pages — still catches structured fields
    ...
  }
```

- [ ] **Step 3: Replace with 3-way branch**

Replace the `let response;` block and the entire if/else (up to but not including the `const text = response.content...` parsing block) with:

```ts
  // Three-way branch: native-PDF (best, direct Anthropic), image-batched
  // (Langdock-compatible), or text-mode fallback (last-resort if no PDF)
  let parsed: Record<string, { wert: unknown; quelle: string }> | null = null;
  let modeUsed: 'native-pdf' | 'image-batched' | 'text';
  let batchesOk = 0;
  let batchesFailed = 0;

  if (pdfBuffer && anthropicSupportsNativePdf()) {
    modeUsed = 'native-pdf';
    const miniPdf = await extractPdfPages(pdfBuffer, formPages);
    const base64 = miniPdf.toString('base64');
    const response = await callWithRetry(() => createAnthropicMessage({
      model: handwritingModel,
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
          { type: 'text' as const, text: `${HANDWRITING_PROMPT}${promptSuffix}` },
        ],
      }],
    }));
    if (response.stop_reason === 'max_tokens') {
      logger.warn('Handwriting native-PDF hit max_tokens', { pages: formPages.map(p => p + 1) });
    }
    const text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('');
    try {
      const jsonStr = extractJsonFromText(text);
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        const { jsonrepair } = await import('jsonrepair');
        parsed = JSON.parse(jsonrepair(jsonStr));
      }
    } catch (err) {
      logger.warn('Handwriting native-PDF JSON parse failed', {
        error: err instanceof Error ? err.message : String(err),
        sample: text.slice(0, 300),
      });
      return result;
    }
  } else if (pdfBuffer) {
    modeUsed = 'image-batched';
    // Langdock-compatible path: render Fragebogen pages as JPEGs and batch them
    const { renderPagesToJpeg } = await import('../utils/pageImageRenderer');
    const imagesByPage = renderPagesToJpeg(pdfBuffer, formPages, 150);
    const renderedPages = formPages.filter(p => imagesByPage.has(p));
    if (renderedPages.length < formPages.length) {
      logger.warn('Some Fragebogen pages failed to render', {
        requested: formPages.length,
        rendered: renderedPages.length,
        missing: formPages.filter(p => !imagesByPage.has(p)).map(p => p + 1),
      });
    }
    const batches = chunk(renderedPages, 4);
    const tasks = batches.map((batchPages, i) => async () => {
      // First batch sets cache; subsequent batches re-use the cached prompt
      const cacheable = i === 0 || true; // cache on every batch — cache_control is idempotent
      return await callHandwritingBatch(batchPages, imagesByPage, promptSuffix, cacheable);
    });
    const settled = await runWithConcurrency(tasks, 2);
    const merged: Record<string, { wert: unknown; quelle: string }> = {};
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) {
        batchesOk++;
        // Last-batch-wins for duplicate keys (rare; acceptable since merge below
        // only fills empty-target fields anyway)
        Object.assign(merged, r.value);
      } else {
        batchesFailed++;
      }
    }
    parsed = batchesOk > 0 ? merged : null;
  } else {
    modeUsed = 'text';
    // Last-resort: send OCR text only (used when no PDF buffer is available)
    const formTextBlock = formPages
      .map(p => `=== SEITE ${p + 1} ===\n${pageTexts[p] ?? ''}`)
      .join('\n\n');
    const response = await callWithRetry(() => createAnthropicMessage({
      model: handwritingModel,
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: 'user' as const,
        content: `${HANDWRITING_PROMPT}${promptSuffix}\n\n--- FORMULARE (OCR-Text) ---\n\n${formTextBlock}`,
      }],
    }));
    const text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('');
    try {
      const jsonStr = extractJsonFromText(text);
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        const { jsonrepair } = await import('jsonrepair');
        parsed = JSON.parse(jsonrepair(jsonStr));
      }
    } catch (err) {
      logger.warn('Handwriting text-mode JSON parse failed', {
        error: err instanceof Error ? err.message : String(err),
        sample: text.slice(0, 300),
      });
      return result;
    }
  }

  if (!parsed) {
    logger.warn('Handwriting extraction produced no parsed data', { mode: modeUsed });
    return result;
  }
```

- [ ] **Step 4: Update the existing log line at the end of `extractHandwriting`**

Find the `logger.info('Handwriting extraction completed', ...)` near line 621 and change to:

```ts
  logger.info('Handwriting extraction completed', {
    mode: modeUsed,
    fieldsFound: Object.keys(parsed).length,
    merged,
    skipped: skipped.length,
    skippedFields: skipped,
    formPages: formPages.length,
    ...(modeUsed === 'image-batched' ? { batchesOk, batchesFailed } : {}),
  });
```

- [ ] **Step 5: Update the early `mode` log line near line 491**

Find:
```ts
  logger.info('Fragebogen pages detected for handwriting extraction', {
    pages: formPages.map(p => p + 1),
    count: formPages.length,
    mode: pdfBuffer && anthropicSupportsNativePdf() ? 'native-pdf' : 'text',
  });
```

Replace `mode:` with the 3-way version:
```ts
    mode: !pdfBuffer ? 'text' : (anthropicSupportsNativePdf() ? 'native-pdf' : 'image-batched'),
```

- [ ] **Step 6: Verify tsc + existing tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: EXIT 0, 99/99 baseline + 8 new tests = 107 passing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/extraction.ts
git commit -m "feat(handwriting): add image-batched mode for Langdock production"
```

---

## Task 5: Integration test — image-batched mode with mocked Claude

**Files:**
- Modify: `backend/src/services/__tests__/extraction.handwriting-batched.test.ts`

This test verifies the control flow without hitting Claude. Mocks `createAnthropicMessage` to simulate 2 successful + 1 failed batch.

- [ ] **Step 1: Add integration test**

Append to `extraction.handwriting-batched.test.ts`:

```ts
import { vi, beforeEach } from 'vitest';

// Mock the Anthropic call surface
vi.mock('../anthropic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../anthropic')>();
  return {
    ...actual,
    createAnthropicMessage: vi.fn(),
    callWithRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock('../../utils/pageImageRenderer', () => ({
  renderPagesToJpeg: vi.fn(),
}));
vi.mock('../extractionProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extractionProvider')>();
  return {
    ...actual,
    anthropicSupportsNativePdf: () => false, // force image-batched mode
    detectProvider: () => 'langdock' as const,
  };
});

describe('extractHandwriting image-batched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges fields from successful batches and skips failed ones', async () => {
    const { extractHandwriting } = await import('../extraction');
    const { createAnthropicMessage } = await import('../anthropic');
    const { renderPagesToJpeg } = await import('../../utils/pageImageRenderer');

    // Render returns 5 pages of dummy base64
    (renderPagesToJpeg as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([0, 1, 2, 3, 4].map(i => [i, 'BASE64DATA']))
    );

    // 5 pages → batches of 4 → 2 batches
    // First batch returns telefon, second batch returns email
    let callCount = 0;
    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"telefon":{"wert":"06545 9121110","quelle":"Seite 1"}}' }],
        };
      }
      if (callCount === 2) {
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"email":{"wert":"info@example.de","quelle":"Seite 5"}}' }],
        };
      }
      throw new Error('unexpected batch');
    });

    const result = {
      schuldner: {
        telefon: { wert: '', quelle: '' },
        email: { wert: '', quelle: '' },
        // ... (real type has many more fields; test only inspects two)
      },
    } as never;

    // pageTexts contains FRAGEBOGEN markers on pages 0-4 to trigger detection
    const pageTexts = ['Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen'];
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF dummy

    await extractHandwriting(result, pdfBuffer, pageTexts);

    expect(callCount).toBe(2);
    expect(result.schuldner.telefon.wert).toBe('06545 9121110');
    expect(result.schuldner.email.wert).toBe('info@example.de');
  });

  it('survives a partial batch failure', async () => {
    const { extractHandwriting } = await import('../extraction');
    const { createAnthropicMessage } = await import('../anthropic');
    const { renderPagesToJpeg } = await import('../../utils/pageImageRenderer');

    (renderPagesToJpeg as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([0, 1, 2, 3, 4].map(i => [i, 'BASE64DATA']))
    );

    let callCount = 0;
    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"telefon":{"wert":"06545 9121110","quelle":"Seite 1"}}' }],
        };
      }
      throw new Error('simulated batch failure');
    });

    const result = {
      schuldner: {
        telefon: { wert: '', quelle: '' },
        email: { wert: '', quelle: '' },
      },
    } as never;
    const pageTexts = ['Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen'];
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46]);

    await extractHandwriting(result, pdfBuffer, pageTexts);

    expect(result.schuldner.telefon.wert).toBe('06545 9121110');
    expect(result.schuldner.email.wert).toBe(''); // failed batch → no email merged
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npx vitest run src/services/__tests__/extraction.handwriting-batched.test.ts`
Expected: All chunk + concurrency + 2 integration tests PASS.

If the integration tests fail because `extractHandwriting` returns early on `result.schuldner` missing fields, adjust the mock `result` object to include the full `Schuldner` shape (use `as never` to bypass type-check on the test fixture). The merge code only mutates the listed fields, so a partial fixture is acceptable.

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `cd backend && npx vitest run`
Expected: 99 baseline + 10 new = 109 passing.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/__tests__/extraction.handwriting-batched.test.ts
git commit -m "test(handwriting): integration test for image-batched mode"
```

---

## Task 6: Smoke test against running backend (manual)

**Goal:** verify the new mode actually runs end-to-end against a real Langdock-style env.

- [ ] **Step 1: Local dev — confirm native-PDF still works**

In `.env` ensure `EXTRACTION_PROVIDER` is unset or `=anthropic` (NOT `openai`). Re-extract a Fragebogen-heavy akte (e.g. Eilers / Cochem). Tail `backend/data/logs/insolvenz-YYYY-MM-DD.log` and confirm:
```
"Fragebogen pages detected for handwriting extraction", mode:"native-pdf"
"Handwriting extraction completed", mode:"native-pdf", merged: > 0
```

- [ ] **Step 2: Local dev — simulate Langdock**

Temporarily set in `.env`:
```
ANTHROPIC_BASE_URL=https://api.langdock.com/anthropic/eu
EXTRACTION_PROVIDER=anthropic
```
(plus a valid Langdock token in `ANTHROPIC_API_KEY`).

Re-extract the same akte. Confirm logs show:
```
"Fragebogen pages detected for handwriting extraction", mode:"image-batched"
"Handwriting extraction completed", mode:"image-batched", merged: > 0, batchesOk: > 0
```

- [ ] **Step 3: Compare results**

Verify in the frontend that handwritten fields like Telefon, E-Mail, Geschäftszweig are populated for the akte (compare to the previous run where they were missing).

- [ ] **Step 4: Restore .env**

Revert the temporary Langdock env-var changes back to local values.

- [ ] **Step 5: Commit (if any small fixes were needed)**

If the smoke surfaced bugs, fix them in extraction.ts and commit. Otherwise no commit.

---

## Task 7 (Optional): OCR-Layer Integration

This is the secondary "auch zum OCR layer hinzufügen" goal. Skip if you want to ship Task 1-6 first; revisit as a follow-up PR.

**Files:**
- Modify: `backend/src/services/extraction.ts` — accept optional `ocrResult` in `extractHandwriting`, inject synthetic word entries after successful merge.
- Modify: `backend/src/services/extraction.ts` (caller site around line 1031-1046) — re-run `addOcrTextLayer` if synthetic entries were added.

- [ ] **Step 1: Extend `extractHandwriting` signature**

Change the existing signature:
```ts
export async function extractHandwriting(
  result: ExtractionResult,
  pdfBuffer: Buffer | null,
  pageTexts: string[],
  ocrResult?: OcrResult | null,  // NEW
): Promise<ExtractionResult>
```

Add `OcrResult` to the imports if needed: `import type { OcrResult } from './ocrService';`.

- [ ] **Step 2: After the existing `mergeField` block, inject synthetic OCR entries**

After the final `merged++` accumulation but before the `logger.info('Handwriting extraction completed', ...)`:

```ts
  // Inject synthetic OCR entries for handwriting findings so frontend Ctrl-F
  // can find handwritten values on the right page (footer band; not pixel-exact)
  if (ocrResult && parsed) {
    let ocrEntriesAdded = 0;
    for (const [field, sv] of Object.entries(parsed)) {
      if (!sv?.wert) continue;
      const valueStr = String(sv.wert).trim();
      if (!valueStr) continue;
      // Parse "Seite X, ..." from the quelle to find the target page
      const m = String(sv.quelle ?? '').match(/Seite\s+(\d+)/i);
      if (!m) continue;
      const pageOneIndexed = parseInt(m[1], 10);
      const pageIdx = pageOneIndexed - 1;
      if (pageIdx < 0 || pageIdx >= ocrResult.pages.length) continue;
      // Footer-band polygon (in inches; ocrLayerService converts to points)
      // Page is ~8.27 x 11.69 inches A4; place at y = 11.4 to 11.6
      const footerY1 = 11.4;
      const footerY2 = 11.6;
      const synthetic = {
        text: valueStr,
        confidence: 0.5, // marks as synthetic
        polygon: [0.5, footerY1, 7.5, footerY1, 7.5, footerY2, 0.5, footerY2],
      };
      const page = ocrResult.pages[pageIdx];
      if (!page.wordConfidences) page.wordConfidences = [];
      page.wordConfidences.push(synthetic);
      ocrEntriesAdded++;
    }
    if (ocrEntriesAdded > 0) {
      logger.info('Handwriting OCR-layer annotations injected', { ocrEntriesAdded });
    }
  }
```

- [ ] **Step 3: Update caller to pass `ocrResult`**

Find the call to `extractHandwriting(result, pdfBuffer, pageTexts)` in extraction.ts (likely around line 1175 or wherever Stage 3c is invoked). Change to:
```ts
  result = await extractHandwriting(result, pdfBuffer, pageTexts, ocrResult);
```

- [ ] **Step 4: Re-run `addOcrTextLayer` after handwriting if entries were added**

After Stage 3c completes in the main pipeline, add:

```ts
  // If handwriting added OCR-layer annotations, rebuild the searchable PDF
  if (ocrResult && pdfBuffer) {
    try {
      const { addOcrTextLayer } = await import('./ocrLayerService');
      const updatedPdf = addOcrTextLayer(pdfBuffer, ocrResult);
      if (updatedPdf !== pdfBuffer && extractionId) {
        const ocrPdfDir = path.join(path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs'), String(extractionId));
        (await import('fs')).writeFileSync(path.join(ocrPdfDir, '0_gerichtsakte.pdf'), updatedPdf);
        logger.info('PDF mit Handschrift-Annotation aktualisiert', { extractionId });
      }
    } catch (err) {
      logger.warn('Failed to rebuild OCR layer with handwriting annotations', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

- [ ] **Step 5: Verify tsc + tests**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: EXIT 0, all 109 tests PASS (Task 7 doesn't add new tests; the existing flow keeps working when `ocrResult` is undefined).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/extraction.ts
git commit -m "feat(handwriting): inject synthetic OCR-layer entries for frontend search"
```

---

## Task 8: Open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/handwriting-image-batched-langdock
```

- [ ] **Step 2: Create PR via gh CLI**

```bash
gh pr create --base main --head feat/handwriting-image-batched-langdock \
  --title "feat(handwriting): image-batched mode for Langdock + OCR-layer integration" \
  --body "Implements the spec at docs/superpowers/specs/2026-04-22-handwriting-image-batched-langdock-design.md.

## What changed
- New \`image-batched\` mode in Stage 3c handwriting pass: renders Fragebogen pages as JPEG (150 DPI) via existing \`renderPagesToJpeg\`, batches 4 pages per call, max 2 batches in flight via inline \`runWithConcurrency\` worker pool, partial failures tolerated via \`Promise.allSettled\`.
- Each image gets a \`=== SEITE X ===\` text label so Claude attributes \`quelle\` correctly.
- Reuses existing \`HANDWRITING_PROMPT\`, \`mergeField\`, and skipped-logging from PR #17.
- \`stop_reason === 'max_tokens'\` is detected and warned; jsonrepair handles partial truncation.
- (Task 7) Optional OCR-layer integration: synthetic word entries appended to \`ocrResult\` for frontend Ctrl-F findability; PDF re-saved with updated text layer.

## Why
Production runs on Langdock which blocks \`type: 'document'\`. Old fallback was Azure DI text-OCR — useless on German handwriting (Cochem akte: 0 useful merges). Image content type IS supported on Langdock (Stage 2a hybrid mode already uses it).

## Test plan
- [x] Backend tsc clean
- [x] vitest 99/99 baseline + new chunk/concurrency/integration tests all pass
- [ ] Local smoke (native-PDF mode unchanged)
- [ ] Local smoke with simulated Langdock env → \`mode:\"image-batched\"\` in logs, \`merged > 0\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Confirm PR URL printed**

The command outputs the PR URL. Save it and report to the user.

---

## Self-Review Notes

(For the engineer reading this — these were caught during plan self-review:)

1. **Spec coverage:** every section of the spec has a corresponding task. OCR-layer integration is explicitly Task 7 (optional) per spec's "sekundäres Ziel" framing.
2. **Type consistency:** `chunk`, `runWithConcurrency`, and `callHandwritingBatch` signatures are referenced in Task 4 with the same names defined in Tasks 1-3.
3. **No placeholders:** all code blocks are concrete; no "TODO" or "see above" without showing code.
4. **Caching in Task 4:** the `cacheable: i === 0 || true` looks redundant — that's intentional. `cache_control` is idempotent across batches; setting it on every batch is correct, the variable name was just retained for clarity if a future change wants to cache only the first.
