# Semantic Page Verification — Design Spec

## Problem

The current `pageVerifier.ts` does post-extraction verification via fuzzy text matching. It searches for each extracted value's text across all pages and either confirms, "corrects", or fails the reference. This approach has fundamental flaws:

1. **Ambiguity**: Common values (dates, names, amounts) appear on multiple pages in different document sections. The verifier sees multiple matches and marks the field as unverified.
2. **No document context**: It doesn't understand that a `beschlussdatum` should come from a Beschluss page, not a casual mention in a Zustellungsvermerk. It treats all pages equally.
3. **Wrong corrections**: When it "corrects" a page reference, it picks any page with a text match, regardless of whether that page is the authoritative source.
4. **Loose matching**: Fuzzy strategies (word-part matching, Levenshtein sliding window) produce false positives, especially for short values.

Result: almost all fields end up `verifiziert: false` or with wrong page references.

## Solution

Replace text-matching verification with a single Claude Haiku API call that semantically verifies all extracted fields against the actual page texts. Claude understands document structure and can distinguish authoritative sources from incidental mentions.

## Architecture

### New pipeline

```
Extract (existing) → semanticVerify (new Haiku call) → letterChecklist (existing) → done
```

Replaces: `verifyPageReferences()` from `pageVerifier.ts`

### New file: `backend/src/utils/semanticVerifier.ts`

**Input**: `ExtractionResult` + `pageTexts: string[]`

**Process**:
1. Walk the ExtractionResult and collect all `{wert, quelle}` fields with their dot-notation paths (e.g., `verfahrensdaten.beschlussdatum`). Only objects with both `wert` and `quelle` properties are collected — `Frist` items (which have `quelle` but no `wert`/`verifiziert`) are structurally excluded.
2. Filter to fields with non-empty `wert`
3. Build verification prompt (see Prompt Design below)
4. Call Haiku via the `callWithRetry` function exported from `anthropic.ts` (retries on 429 with exponential backoff, no modification needed to the function itself)
5. Parse JSON response using `jsonrepair` (imported directly — same package already in dependencies)
6. Apply results back using the collected field references (mutated in-place). Fields are matched by their 1-based `nr` index, not by path — this avoids complexity with array indices.

**Output**: The same `ExtractionResult` object with `verifiziert` flags set and `quelle` values corrected where needed.

**Note on array fields**: `schuldner.kinder`, `schuldner.fruehere_adressen`, and `forderungen.betroffene_arbeitnehmer` may contain `SourcedValue` objects mixed with plain strings. The walker collects any `{wert, quelle}` objects found in these arrays. In the numbered field list sent to Claude, they appear with descriptive labels (e.g., "schuldner.kinder[0]"). The response maps back via `nr` index to the in-memory reference, so exact path format doesn't matter for applying results.

### Prompt Design

The prompt contains three sections:

**1. Document content** — all page texts with clear markers:
```
=== SEITE 1 ===
Amtsgericht Köln, Az: 73 IN 123/25 ...

=== SEITE 2 ===
Beschluss vom 18.12.2025 ...
```

**2. Fields to verify** — numbered list with path, value, claimed source:
```
1. verfahrensdaten.aktenzeichen | Wert: "73 IN 123/25" | Quelle: "Seite 1, Beschluss"
2. verfahrensdaten.beschlussdatum | Wert: "18.12.2025" | Quelle: "Seite 3, Beschluss"
```

**3. Instructions** — verify each field with semantic understanding:
- Does the value actually exist in the document?
- Is the referenced page correct?
- Is this the **authoritative** source (not just any mention)?

The prompt includes guidance on authoritative sources for German insolvency files:
- Verfahrensdaten → Beschluss/Verfügung des Gerichts
- Schuldnerdaten → Rubrum des Beschlusses, Insolvenzantrag
- Antragstellerdaten → Insolvenzantrag
- Forderungen → Insolvenzantrag / Forderungsaufstellung
- Gutachterbestellung → Beschluss zur Gutachterbestellung
- Ermittlungsergebnisse → Jeweiliger Fachbericht (Grundbuch, GV-Mitteilung, etc.)

The key instruction: "Ein Datum oder Name kann auf mehreren Seiten vorkommen. Wähle die Seite, auf der der Wert in seinem FACHLICHEN KONTEXT steht."

### Response Format

Claude returns a JSON array:
```json
[
  {"nr": 1, "verifiziert": true},
  {"nr": 2, "verifiziert": true, "quelle_korrigiert": "Seite 2, Beschluss vom 18.12.2025"},
  {"nr": 3, "verifiziert": false, "begruendung": "Wert nicht im Dokument gefunden"}
]
```

Fields:
- `nr` (number): 1-based index matching the field list
- `verifiziert` (boolean): true if value exists in document with correct/corrected source
- `quelle_korrigiert` (string, optional): corrected source reference when original was wrong
- `begruendung` (string, optional): explanation when verifiziert is false

### Applying Results

For each verification entry:
- Set `field.verifiziert = entry.verifiziert`
- If `entry.quelle_korrigiert` is provided: replace `field.quelle` with the corrected value
- Log statistics: verified count, corrected count, failed count, skipped count

### Error Handling

- If the Haiku verification call fails (rate limit, timeout, etc.): log a warning, return the result with `verifiziert` left undefined on all fields. Never fail the entire extraction because verification failed.
- Use the same `callWithRetry` pattern from `anthropic.ts` (retry on 429 with exponential backoff).
- If the response JSON is malformed: attempt `jsonrepair`, then fall back to graceful degradation (no verification).

### Token Budget and Limits

German legal documents typically run 500-700 tokens per page. Conservative estimates:

| Document size | Page text tokens | Total input | Fits in 200k? |
|---------------|-----------------|-------------|---------------|
| 50 pages      | ~30k            | ~33k        | Yes           |
| 100 pages     | ~60k            | ~63k        | Yes           |
| 200 pages     | ~120k           | ~123k       | Yes           |
| 300 pages     | ~180k           | ~183k       | Tight         |
| 400+ pages    | ~240k+          | ~243k+      | No            |

Before calling the API, estimate total tokens (rough heuristic: `totalChars / 3`). If estimated tokens exceed 150k, truncate by omitting pages from the middle of the document (keep first 100 + last 100 pages, which typically contain the most important sections: Beschluss/Rubrum at the front, recent correspondence at the back). Log a warning when truncation occurs.

**`max_tokens` for response**: Set to `4096`. The verification response is a compact JSON array (~50 fields × ~30 tokens each ≈ 1.5k tokens). 4096 provides comfortable headroom.

### Cost

Additional ~$0.08-0.10 per 200-page extraction (one Haiku call). About 30% increase over the base extraction cost of ~$0.25.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `backend/src/utils/semanticVerifier.ts` | **Create** | New semantic verification module |
| `backend/src/services/anthropic.ts` | **Modify** | Export `anthropic` client instance and `callWithRetry<T>` function (both currently module-private) |
| `backend/src/services/extraction.ts` | **Modify** | Replace `verifyPageReferences()` with `await semanticVerify()` |
| `backend/src/utils/pageVerifier.ts` | **Delete** | Replaced by semanticVerifier |
| `backend/src/utils/fuzzyMatch.ts` | **Delete** | No longer needed |
| `backend/src/utils/pageParser.ts` | **Delete** | No longer needed |
| `backend/src/utils/__tests__/pageVerifier.test.ts` | **Delete** | Tests for removed module |
| `backend/src/utils/__tests__/fuzzyMatch.test.ts` | **Delete** | Tests for removed module |
| `backend/src/utils/__tests__/pageParser.test.ts` | **Delete** | Tests for removed module |
| `backend/src/utils/__tests__/semanticVerifier.test.ts` | **Create** | Tests for new module (mock API calls) |

## What Does NOT Change

- **Frontend**: `verifiziert` and `pruefstatus` types are unchanged. DataField and PrueflisteTab display logic stays the same.
- **Shared types**: `SourcedValue`, `ExtractionResult` — no changes.
- **Letter checklist**: `letterChecklist.ts` — unchanged, runs after verification as before.
- **Extraction prompt**: The main extraction prompt in `anthropic.ts` — unchanged.
- **Database schema**: No changes.

## Testing

Unit tests for `semanticVerifier.ts` will mock the Anthropic API call and verify:
1. Fields with non-empty wert are collected and sent for verification
2. Fields with null/empty wert are skipped (verifiziert stays undefined)
3. Verified fields get `verifiziert: true`
4. Corrected fields get updated `quelle` + `verifiziert: true`
5. Failed fields get `verifiziert: false`
6. API failure results in graceful degradation (no verifiziert set)
7. Malformed API response is handled (jsonrepair, then fallback)

Integration testing: run `npm run verify -- ../standardschreiben/Bankenanfrage.pdf` and confirm verification results are sensible.
