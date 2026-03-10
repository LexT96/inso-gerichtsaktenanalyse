# Post-Extraction Page Verification Layer

## Problem

Claude AI extracts values from insolvency PDFs with source references ("Seite X, ..."), but page numbers are often off by 1-2 pages or occasionally completely wrong. This undermines trust in the source navigation feature.

## Goal

100% reliability: every field is either correctly sourced (exact page) or flagged as unreliable.

## Approach

Post-extraction verification layer that checks every extracted value against actual per-page PDF text using fuzzy matching.

### Behavior

| Scenario | Action |
|----------|--------|
| Value found on reported page | Keep as-is, `verifiziert: true` |
| Value found on different page | Silently correct page number in `quelle`, `verifiziert: true` |
| Value not found on any page | `verifiziert: false` — field marked as unreliable in UI |

## Data Model

Add optional `verifiziert` to `SourcedValue`:

```typescript
interface SourcedValue<T = string> {
  wert: T | null;
  quelle: string;
  verifiziert?: boolean; // undefined = not checked, true = verified, false = unreliable
}
```

No database schema changes — stored inside `result_json`.

## Verification Engine

New file: `backend/src/utils/pageVerifier.ts`

```
verifyPageReferences(result: ExtractionResult, pageTexts: string[]): ExtractionResult
```

1. Walk all fields recursively — find every `{wert, quelle}` object
2. Parse page number from `quelle`
3. Skip fields with null/empty `wert` or no page reference
4. Fuzzy search for `wert` in `pageTexts[pageNum - 1]`
5. If not found, search all pages
6. Correct or flag accordingly

### Fuzzy Matching (type-aware)

| Value Type | Matching Logic |
|---|---|
| Names | Normalize whitespace, case-insensitive, match individual parts |
| Dates | Parse to canonical form, match common German date formats |
| Currency/Numbers | Strip formatting, compare numeric value |
| Addresses | Match street name + number separately |
| Case numbers | Normalize spaces/dashes, match core pattern |
| General strings | Levenshtein distance with threshold, normalized whitespace |

## Integration

```
PDF Upload
    ↓
extractTextPerPage(buffer) → pageTexts[]     ← ALWAYS (both modes)
    ↓
Claude Extraction → ExtractionResult
    ↓
verifyPageReferences(result, pageTexts)       ← NEW
    ↓
validateLettersAgainstChecklists(result)
    ↓
Save to DB
```

In native PDF mode (≤100 pages): `extractTextPerPage()` added as side channel for verification only. Does not change what Claude sees.

## Frontend

- `DataField.tsx`: unreliable fields (`verifiziert: false`) get orange/warning badge, no page navigation
- New stat: `stats_unverified` counter
- No changes to PdfViewer, PdfContext, or highlighting

## Files

**Create:**
- `backend/src/utils/pageVerifier.ts`

**Modify:**
- `backend/src/types/extraction.ts` — add `verifiziert?: boolean`
- `backend/src/services/extraction.ts` — always call `extractTextPerPage()`, add verification step
- `backend/src/utils/validation.ts` — pass through `verifiziert`
- `frontend/src/components/extraction/DataField.tsx` — render unreliable state

## Out of Scope

- No DB schema changes
- No Claude prompt changes
- No PDF viewer changes
- No letter validation changes
