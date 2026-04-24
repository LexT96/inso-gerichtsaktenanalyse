# Handwriting Field Registry + Gap-Fill Pass (Sprint 1)

## Problem

The current handwriting pass (`extractHandwrittenFormFields` in `backend/src/services/extraction.ts`) uses one monolithic `HANDWRITING_PROMPT` that enumerates 20+ target fields in a single JSON schema. When Claude Vision processes the 4-page batches, it systematically misses certain fields — even when the data is clearly readable. Verified gap: Geldt-CNC akte's `betriebsstaette_adresse` is on page 4 under field "Name und Anschrift der Firma oder ehemaligen Firma" with a checkbox "befinden sich noch unter der Anschrift" — both Sonnet 4.6 and Opus 4.6 via Langdock miss it in the multi-field prompt, but a targeted single-field probe finds it in 5s.

This is not a model-tier or image-quality problem; it's attention dilution in a 20+ field prompt. Patching the prompt for this specific checkbox wouldn't generalize — other akte have other quiet fields, other checkboxes, other Anlage layouts.

## Scope (Sprint 1 only)

Sprint 1 builds the foundation:
1. A declarative TypeScript registry of handwriting target fields
2. Refactor the main-pass prompt to be generated from that registry (no behavior change)
3. A **gap-fill pass** after the main pass: for each critical field still empty, render the same Fragebogen pages and send a **focused single-field mini-probe** to Claude. Merge results.

Explicitly **out of scope** for this sprint (follow-up work):
- Anlage-aware routing (Sprint 2)
- `ExtractionCandidate` fusion for handwriting (Sprint 3)
- Per-field extractors as standalone calls for every field (rejected — cost explosion)
- Non-critical fields in the gap-fill loop (only critical fields trigger probes)
- Suspicion-based triggers (only empty-and-critical triggers in this sprint)
- Changing the `mergeField` "fill-only-empty" semantics

## Registry

File: `backend/src/utils/handwritingFieldRegistry.ts`

```ts
export interface HandwritingFieldDef {
  /** Key in the parsed Claude JSON response + merge target on result.schuldner.* */
  key: string;
  /** Dot-path on ExtractionResult (for future candidate emission; unused in Sprint 1) */
  path: string;
  /** 'critical' fields trigger a gap-fill probe when still empty after main pass */
  criticality: 'critical' | 'standard' | 'optional';
  /** Short human label used in prompts and logs */
  label: string;
  /** Positive anchors — form-field labels Claude should scan for */
  anchors: string[];
  /** Negative anchors — labels that look similar but mean something else */
  negativeAnchors?: string[];
  /** Edge-case hints — e.g. "fill even if checkbox says identical to private address" */
  edgeCases?: string[];
  /** Anlage hints — which form sections typically contain this field */
  anlageHints?: string[];
}
```

Target coverage: exactly the 23 scalar fields in the existing merge list (plus `arbeitnehmer_anzahl` and `betriebsrat` which use typed merges). Critical fields (trigger gap-fill) for Sprint 1: `betriebsstaette_adresse`, `email`, `telefon`, `steuerberater`, `finanzamt`, `firma`. Others default to `standard`.

## Refactor

`HANDWRITING_PROMPT` in `extraction.ts` becomes a function that builds the same prompt from the registry. No behavior change — same schema, same examples, same fields. Goal: DRY, and prep for Sprint 2 where the prompt becomes Anlage-aware.

## Gap-Fill Pass

New internal function `runHandwritingGapFill(result, pdfBuffer, formPages, imagesByPage)` runs after the main pass's merge completes. Logic:

1. Iterate the registry. For each entry with `criticality === 'critical'`:
   - Check if `result.schuldner[key].wert` is still empty/null after main-pass merge.
   - If empty, it's a gap.
2. For each gap, render the same Fragebogen pages as JPEG (reuse the main pass's `imagesByPage` map — don't re-render).
3. Send a focused mini-probe to Claude: same Langdock image-content-type, but the prompt is **single-field** and enumerates the registry's `anchors`, `negativeAnchors`, `edgeCases` for that field.
4. Parse response → if a value came back, merge it into `result.schuldner[key]` via the same fill-only-empty rule.
5. Log: `{ gapsChecked, gapsFilled, probesSent, probesFailed, extraDurationMs }`.

Concurrency: single gap probes in sequence (simpler, and typical akte will have 0-2 gaps).

Cost: each probe ~6-8K input tokens (images re-used from main pass — pass images as base64 per call; prompt cache should hit), ~200 output tokens. Typical: 0-3 gaps per akte → $0.10-$0.20 extra. Worst case (5-6 gaps): $0.30-0.40 extra per akte.

## Wiring

`extractHandwrittenFormFields` call site:

```ts
const outcome = await extractHandwrittenFormFields(result, pdfBuffer, pageTexts, ocrResult);
// <- internally: main pass + gap-fill + OCR-layer injection
```

The Sprint 1 implementation keeps the existing `Promise<{ result, ocrEntriesAdded }>` signature (no breaking change). Internally, the function now has:

```
detectFragebogenPages
  → 3-way mode branch (native-pdf | image-batched | text) — unchanged
    → main-pass merge — unchanged
      → NEW: runHandwritingGapFill (only when mode is not 'text' and imagesByPage is available)
        → mergeField on discovered values
          → OCR-layer injection (includes gap-fill findings)
```

Text-mode fallback (no pdfBuffer) skips gap-fill — it has no way to render pages.

## Test Plan

- Unit: registry structure (each entry has required fields, keys unique)
- Unit: `buildMainPrompt(registry)` produces a string containing every `key` and `label`
- Unit: `buildProbePrompt(registryEntry)` produces a focused single-field prompt with the anchors
- Integration: `runHandwritingGapFill` with mocked Claude returning a value for the probe → field is merged
- Integration: gap-fill only triggers for `critical` fields still empty
- Integration: no gaps → 0 probes sent
- Manual smoke: probe script (existing `probe-betriebsstaette.ts` pattern) verifies Geldt akte's betriebsstätte is now filled after gap-fill

## Files

- **Create**: `backend/src/utils/handwritingFieldRegistry.ts` — registry + helpers (`buildMainPrompt`, `buildProbePrompt`)
- **Create**: `backend/src/utils/__tests__/handwritingFieldRegistry.test.ts`
- **Modify**: `backend/src/services/extraction.ts`:
  - Replace inline `HANDWRITING_PROMPT` constant with a call to `buildMainPrompt(registry)` computed once at module load
  - After main-pass merge, call `runHandwritingGapFill` (new private function in the same file OR a new `handwritingGapFill.ts` — decision deferred to the plan)
- **Modify**: `backend/src/services/__tests__/extraction.handwriting-batched.test.ts` — extend to cover gap-fill trigger/skip paths

## Non-Goals (enforced)

- No new top-level endpoint
- No change to the `ExtractionResult` type
- No change to the existing merge list (23 fields stay 23 fields)
- No change to the integration test fixtures for the image-batched tests

## Rollback

Pure code-add + refactor. Revert via `git revert <commit>` — `extractHandwrittenFormFields` falls back to today's inline prompt + no gap-fill. No schema or DB change.
