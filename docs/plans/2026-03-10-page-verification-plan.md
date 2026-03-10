# Page Verification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a post-extraction verification layer that checks every extracted value's page number against actual per-page PDF text, auto-correcting wrong pages and flagging unreliable fields.

**Architecture:** After Claude extracts values, a new `verifyPageReferences()` function walks all `{wert, quelle}` fields, fuzzy-searches the per-page text array for each value, silently corrects wrong page numbers, and marks unfindable values as `verifiziert: false`. The `extractTextPerPage()` call is made unconditionally (both PDF modes) to provide ground truth text.

**Tech Stack:** TypeScript, Zod (validation), vitest (tests), pdf-parse (text extraction)

---

### Task 1: Set up vitest for backend

**Files:**
- Modify: `backend/package.json`
- Create: `backend/vitest.config.ts`

**Step 1: Install vitest**

Run: `cd backend && npm install -D vitest`

**Step 2: Create vitest config**

Create `backend/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
});
```

**Step 3: Add test script to package.json**

Add to `backend/package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Verify vitest works**

Run: `cd backend && npx vitest run`
Expected: 0 tests found, no errors

**Step 5: Commit**
```bash
git add backend/package.json backend/package-lock.json backend/vitest.config.ts
git commit -m "chore: add vitest to backend"
```

---

### Task 2: Add `verifiziert` to type definitions

**Files:**
- Modify: `shared/types/extraction.ts:1-4` (SourcedValue)
- Modify: `shared/types/extraction.ts:7-9` (SourcedNumber)
- Modify: `shared/types/extraction.ts:12-14` (SourcedBoolean)
- Modify: `backend/src/types/extraction.ts:2-5` (SourcedValue)
- Modify: `backend/src/types/extraction.ts:7-10` (SourcedNumber)
- Modify: `backend/src/types/extraction.ts:12-15` (SourcedBoolean)

**Step 1: Update shared types**

In `shared/types/extraction.ts`, add `verifiziert?: boolean` to all three interfaces:

```typescript
export interface SourcedValue<T = string> {
  wert: T | null;
  quelle: string;
  verifiziert?: boolean;
}

export interface SourcedNumber {
  wert: number;
  quelle: string;
  verifiziert?: boolean;
}

export interface SourcedBoolean {
  wert: boolean | null;
  quelle: string;
  verifiziert?: boolean;
}
```

**Step 2: Update backend duplicate types**

In `backend/src/types/extraction.ts`, add the same `verifiziert?: boolean` to all three interfaces.

**Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors (optional field, backwards compatible)

**Step 4: Commit**
```bash
git add shared/types/extraction.ts backend/src/types/extraction.ts
git commit -m "feat: add verifiziert field to SourcedValue types"
```

---

### Task 3: Create `parsePageNumber` utility (shared between frontend and backend)

**Files:**
- Create: `backend/src/utils/pageParser.ts`
- Create: `backend/src/utils/__tests__/pageParser.test.ts`

**Step 1: Write the failing test**

Create `backend/src/utils/__tests__/pageParser.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parsePageNumber, replacePageNumber } from '../pageParser';

describe('parsePageNumber', () => {
  it('parses "Seite 3, Beschluss"', () => {
    expect(parsePageNumber('Seite 3, Beschluss vom 18.12.2025')).toBe(3);
  });
  it('parses "Seiten 5-7"', () => {
    expect(parsePageNumber('Seiten 5-7, Insolvenzantrag')).toBe(5);
  });
  it('parses "S. 12"', () => {
    expect(parsePageNumber('S. 12, Mitteilung')).toBe(12);
  });
  it('parses "S.3"', () => {
    expect(parsePageNumber('S.3')).toBe(3);
  });
  it('returns null for empty string', () => {
    expect(parsePageNumber('')).toBeNull();
  });
  it('returns null for quelle without page', () => {
    expect(parsePageNumber('Beschluss vom 18.12.2025')).toBeNull();
  });
});

describe('replacePageNumber', () => {
  it('replaces page in "Seite 3, Beschluss" to "Seite 7, Beschluss"', () => {
    expect(replacePageNumber('Seite 3, Beschluss vom 18.12.2025', 7))
      .toBe('Seite 7, Beschluss vom 18.12.2025');
  });
  it('replaces page in "S. 12, Mitteilung" to "S. 5, Mitteilung"', () => {
    expect(replacePageNumber('S. 12, Mitteilung', 5))
      .toBe('S. 5, Mitteilung');
  });
  it('replaces page in "S.3" to "S.7"', () => {
    expect(replacePageNumber('S.3', 7)).toBe('S.7');
  });
  it('returns original if no page found', () => {
    expect(replacePageNumber('Beschluss', 5)).toBe('Beschluss');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/utils/__tests__/pageParser.test.ts`
Expected: FAIL — module not found

**Step 3: Implement pageParser.ts**

Create `backend/src/utils/pageParser.ts`:
```typescript
const PAGE_REGEX = /(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i;

/** Extract page number from quelle string. Returns null if no page reference found. */
export function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(PAGE_REGEX);
  return match ? parseInt(match[1], 10) : null;
}

/** Replace the page number in a quelle string. Returns original if no page found. */
export function replacePageNumber(quelle: string, newPage: number): string {
  return quelle.replace(PAGE_REGEX, (fullMatch, _oldPage) => {
    return fullMatch.replace(_oldPage, String(newPage));
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/utils/__tests__/pageParser.test.ts`
Expected: All PASS

**Step 5: Commit**
```bash
git add backend/src/utils/pageParser.ts backend/src/utils/__tests__/pageParser.test.ts
git commit -m "feat: add pageParser utility with parsePageNumber and replacePageNumber"
```

---

### Task 4: Create fuzzy matching utilities

**Files:**
- Create: `backend/src/utils/fuzzyMatch.ts`
- Create: `backend/src/utils/__tests__/fuzzyMatch.test.ts`

**Step 1: Write the failing tests**

Create `backend/src/utils/__tests__/fuzzyMatch.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { fuzzyFindInText } from '../fuzzyMatch';

describe('fuzzyFindInText', () => {
  const pageText = `
    Amtsgericht Köln, Az: 73 IN 123/25
    Schuldner: Max Mustermann, geb. 15.03.1985
    Anschrift: Musterstraße 42, 50667 Köln
    Gesamtforderung: 12.345,67 EUR
    Beschluss vom 18.12.2025
  `;

  // Exact string match
  it('finds exact name', () => {
    expect(fuzzyFindInText('Max Mustermann', pageText)).toBe(true);
  });

  // Case insensitive
  it('finds name case-insensitive', () => {
    expect(fuzzyFindInText('max mustermann', pageText)).toBe(true);
  });

  // Whitespace normalization
  it('finds with extra whitespace', () => {
    expect(fuzzyFindInText('Max  Mustermann', pageText)).toBe(true);
  });

  // Date formats
  it('finds date 15.03.1985', () => {
    expect(fuzzyFindInText('15.03.1985', pageText)).toBe(true);
  });

  // Currency/number matching
  it('finds amount 12345.67 (parsed from German format)', () => {
    expect(fuzzyFindInText('12345.67', pageText)).toBe(true);
  });

  it('finds amount in German format', () => {
    expect(fuzzyFindInText('12.345,67', pageText)).toBe(true);
  });

  // Case number (Aktenzeichen)
  it('finds Aktenzeichen with different spacing', () => {
    expect(fuzzyFindInText('73 IN 123/25', pageText)).toBe(true);
  });

  // Partial name match (individual parts)
  it('finds by last name only', () => {
    expect(fuzzyFindInText('Mustermann', pageText)).toBe(true);
  });

  // Not found
  it('returns false for text not in page', () => {
    expect(fuzzyFindInText('Hamburg', pageText)).toBe(false);
  });

  // Boolean values should be skipped (not searchable)
  it('returns true for boolean true (skip verification)', () => {
    expect(fuzzyFindInText('true', pageText)).toBe(true);
  });

  it('returns true for boolean false (skip verification)', () => {
    expect(fuzzyFindInText('false', pageText)).toBe(true);
  });

  // Short values (1-2 chars) should be skipped
  it('returns true for very short values (skip verification)', () => {
    expect(fuzzyFindInText('m', pageText)).toBe(true);
  });

  // Address partial match
  it('finds street name from address', () => {
    expect(fuzzyFindInText('Musterstraße 42, 50667 Köln', pageText)).toBe(true);
  });

  // OCR-like typo tolerance (Levenshtein)
  it('finds name with minor OCR error', () => {
    expect(fuzzyFindInText('Max Musterrnann', pageText)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/utils/__tests__/fuzzyMatch.test.ts`
Expected: FAIL — module not found

**Step 3: Implement fuzzyMatch.ts**

Create `backend/src/utils/fuzzyMatch.ts`:
```typescript
/**
 * Normalize a string for comparison: lowercase, collapse whitespace, trim.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Parse a German-format number string to a plain number string.
 * "12.345,67" → "12345.67", "1.234" → "1234"
 */
function parseGermanNumber(s: string): string | null {
  const cleaned = s.replace(/[€\s]/g, '').trim();
  // German format: dots as thousands separator, comma as decimal
  if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(cleaned)) {
    return cleaned.replace(/\./g, '').replace(',', '.');
  }
  // Already a plain number
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

/**
 * Simple Levenshtein distance.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Check if `value` can be found in `pageText` using fuzzy matching.
 *
 * Matching strategies (tried in order):
 * 1. Skip: booleans, very short values (≤2 chars) → return true (not verifiable)
 * 2. Normalized exact containment (case-insensitive, whitespace-collapsed)
 * 3. Numeric comparison (German format ↔ plain number)
 * 4. Word-part matching: all significant words from value found in page
 * 5. Levenshtein sliding window: find a substring within edit distance threshold
 */
export function fuzzyFindInText(value: string, pageText: string): boolean {
  if (!value || !pageText) return false;

  const trimmed = value.trim();

  // Skip booleans and very short values — not meaningfully verifiable
  if (trimmed.length <= 2) return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'ja' || lower === 'nein') return true;

  const normValue = normalize(trimmed);
  const normPage = normalize(pageText);

  // 1. Exact normalized containment
  if (normPage.includes(normValue)) return true;

  // 2. Numeric comparison
  const valueNum = parseGermanNumber(trimmed);
  if (valueNum !== null) {
    // Search for the numeric value in any format in the page text
    // Extract all number-like sequences from page text
    const numberPatterns = pageText.match(/[\d.,]+/g) || [];
    for (const pattern of numberPatterns) {
      const pageNum = parseGermanNumber(pattern);
      if (pageNum !== null && parseFloat(pageNum) === parseFloat(valueNum)) {
        return true;
      }
    }
  }

  // 3. Word-part matching: all significant words (≥3 chars) from value found in page
  const valueWords = normValue.split(/[\s,;.\/\-]+/).filter(w => w.length >= 3);
  if (valueWords.length >= 2) {
    const allFound = valueWords.every(word => normPage.includes(word));
    if (allFound) return true;
  }

  // 4. Levenshtein sliding window for OCR tolerance
  // Only for values between 5 and 80 chars (too expensive for longer values)
  if (normValue.length >= 5 && normValue.length <= 80) {
    const threshold = Math.max(1, Math.floor(normValue.length * 0.15)); // 15% error rate
    const windowSize = normValue.length;
    // Slide over the page text
    for (let i = 0; i <= normPage.length - windowSize; i++) {
      const window = normPage.substring(i, i + windowSize);
      if (levenshtein(normValue, window) <= threshold) {
        return true;
      }
    }
    // Also try with ±2 char window size for length differences
    for (const delta of [-2, -1, 1, 2]) {
      const altSize = windowSize + delta;
      if (altSize < 3) continue;
      for (let i = 0; i <= normPage.length - altSize; i++) {
        const window = normPage.substring(i, i + altSize);
        if (levenshtein(normValue, window) <= threshold) {
          return true;
        }
      }
    }
  }

  return false;
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/utils/__tests__/fuzzyMatch.test.ts`
Expected: All PASS

**Step 5: Commit**
```bash
git add backend/src/utils/fuzzyMatch.ts backend/src/utils/__tests__/fuzzyMatch.test.ts
git commit -m "feat: add fuzzyMatch utility for page text verification"
```

---

### Task 5: Create `verifyPageReferences` function

**Files:**
- Create: `backend/src/utils/pageVerifier.ts`
- Create: `backend/src/utils/__tests__/pageVerifier.test.ts`

**Step 1: Write the failing tests**

Create `backend/src/utils/__tests__/pageVerifier.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { verifyPageReferences } from '../pageVerifier';
import type { ExtractionResult } from '../../types/extraction';

// Minimal valid ExtractionResult for testing
function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  const defaultSourced = { wert: null, quelle: '' };
  const defaultSourcedNum = { wert: 0, quelle: '' };
  const defaultSourcedBool = { wert: null, quelle: '' };
  return {
    verfahrensdaten: {
      aktenzeichen: { wert: '73 IN 123/25', quelle: 'Seite 1, Beschluss' },
      gericht: { wert: 'Amtsgericht Köln', quelle: 'Seite 1, Beschluss' },
      richter: defaultSourced,
      antragsdatum: defaultSourced,
      beschlussdatum: defaultSourced,
      antragsart: defaultSourced,
      eroeffnungsgrund: defaultSourced,
      zustellungsdatum_schuldner: defaultSourced,
    },
    schuldner: {
      name: { wert: 'Mustermann', quelle: 'Seite 2, Antrag' },
      vorname: { wert: 'Max', quelle: 'Seite 2, Antrag' },
      geburtsdatum: defaultSourced,
      geburtsort: defaultSourced,
      geburtsland: defaultSourced,
      staatsangehoerigkeit: defaultSourced,
      familienstand: defaultSourced,
      geschlecht: defaultSourced,
      aktuelle_adresse: defaultSourced,
      fruehere_adressen: [],
      firma: defaultSourced,
      rechtsform: defaultSourced,
      betriebsstaette_adresse: defaultSourced,
      handelsregisternummer: defaultSourced,
      kinder: [],
    },
    antragsteller: {
      name: defaultSourced,
      adresse: defaultSourced,
      ansprechpartner: defaultSourced,
      telefon: defaultSourced,
      fax: defaultSourced,
      email: defaultSourced,
      betriebsnummer: defaultSourced,
      bankverbindung_iban: defaultSourced,
      bankverbindung_bic: defaultSourced,
    },
    forderungen: {
      hauptforderung_beitraege: defaultSourcedNum,
      saeumniszuschlaege: defaultSourcedNum,
      mahngebuehren: defaultSourcedNum,
      vollstreckungskosten: defaultSourcedNum,
      antragskosten: defaultSourcedNum,
      gesamtforderung: defaultSourcedNum,
      zeitraum_von: defaultSourced,
      zeitraum_bis: defaultSourced,
      laufende_monatliche_beitraege: defaultSourcedNum,
      betroffene_arbeitnehmer: [],
    },
    gutachterbestellung: {
      gutachter_name: defaultSourced,
      gutachter_kanzlei: defaultSourced,
      gutachter_adresse: defaultSourced,
      gutachter_telefon: defaultSourced,
      gutachter_email: defaultSourced,
      abgabefrist: defaultSourced,
      befugnisse: [],
    },
    ermittlungsergebnisse: {
      grundbuch: { ergebnis: defaultSourced, grundbesitz_vorhanden: defaultSourcedBool, datum: defaultSourced },
      gerichtsvollzieher: {
        name: defaultSourced,
        betriebsstaette_bekannt: defaultSourcedBool,
        vollstreckungen: defaultSourced,
        masse_deckend: defaultSourcedBool,
        vermoegensauskunft_abgegeben: defaultSourcedBool,
        haftbefehle: defaultSourcedBool,
        datum: defaultSourced,
      },
      vollstreckungsportal: {
        schuldnerverzeichnis_eintrag: defaultSourcedBool,
        vermoegensverzeichnis_eintrag: defaultSourcedBool,
      },
      meldeauskunft: { meldestatus: defaultSourced, datum: defaultSourced },
    },
    fristen: [],
    standardanschreiben: [],
    fehlende_informationen: [],
    zusammenfassung: '',
    risiken_hinweise: [],
    ...overrides,
  };
}

describe('verifyPageReferences', () => {
  it('marks field as verifiziert: true when value found on correct page', () => {
    const pageTexts = [
      'Amtsgericht Köln, Az: 73 IN 123/25, Beschluss',
      'Schuldner: Max Mustermann',
    ];
    const result = makeResult();
    const verified = verifyPageReferences(result, pageTexts);
    expect(verified.verfahrensdaten.aktenzeichen.verifiziert).toBe(true);
    expect(verified.schuldner.name.verifiziert).toBe(true);
  });

  it('silently corrects page number when value found on different page', () => {
    const pageTexts = [
      'Etwas anderes hier',
      'Amtsgericht Köln, Az: 73 IN 123/25',
    ];
    const result = makeResult();
    // aktenzeichen says "Seite 1" but value is on page 2
    const verified = verifyPageReferences(result, pageTexts);
    expect(verified.verfahrensdaten.aktenzeichen.verifiziert).toBe(true);
    expect(verified.verfahrensdaten.aktenzeichen.quelle).toContain('2');
  });

  it('marks field as verifiziert: false when value not found anywhere', () => {
    const pageTexts = [
      'Completely unrelated text',
      'More unrelated text',
    ];
    const result = makeResult();
    const verified = verifyPageReferences(result, pageTexts);
    expect(verified.verfahrensdaten.aktenzeichen.verifiziert).toBe(false);
  });

  it('skips fields with null/empty wert', () => {
    const pageTexts = ['Some text'];
    const result = makeResult();
    const verified = verifyPageReferences(result, pageTexts);
    // richter has wert: null, should not have verifiziert set
    expect(verified.verfahrensdaten.richter.verifiziert).toBeUndefined();
  });

  it('skips fields with no page reference in quelle', () => {
    const pageTexts = ['Some text with Mustermann'];
    const result = makeResult({
      schuldner: {
        ...makeResult().schuldner,
        name: { wert: 'Mustermann', quelle: 'Beschluss' }, // no "Seite X"
      },
    });
    const verified = verifyPageReferences(result, pageTexts);
    expect(verified.schuldner.name.verifiziert).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/utils/__tests__/pageVerifier.test.ts`
Expected: FAIL — module not found

**Step 3: Implement pageVerifier.ts**

Create `backend/src/utils/pageVerifier.ts`:
```typescript
import { parsePageNumber, replacePageNumber } from './pageParser';
import { fuzzyFindInText } from './fuzzyMatch';
import { logger } from './logger';
import type { ExtractionResult } from '../types/extraction';

interface SourcedField {
  wert: unknown;
  quelle: string;
  verifiziert?: boolean;
}

function isSourcedField(v: unknown): v is SourcedField {
  return v !== null && typeof v === 'object' && 'wert' in v && 'quelle' in v;
}

function valueToString(wert: unknown): string {
  if (wert === null || wert === undefined) return '';
  if (typeof wert === 'boolean') return wert ? 'true' : 'false';
  return String(wert);
}

/**
 * Walk an object recursively, finding all {wert, quelle} fields and verifying them.
 * Mutates the object in place.
 */
function walkAndVerify(obj: unknown, pageTexts: string[], stats: { verified: number; corrected: number; unreliable: number }): void {
  if (obj === null || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walkAndVerify(item, pageTexts, stats);
    }
    return;
  }

  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (isSourcedField(value)) {
      verifyField(value, pageTexts, stats);
    } else if (typeof value === 'object' && value !== null) {
      walkAndVerify(value, pageTexts, stats);
    }
  }
}

function verifyField(field: SourcedField, pageTexts: string[], stats: { verified: number; corrected: number; unreliable: number }): void {
  const wertStr = valueToString(field.wert);

  // Skip empty fields
  if (!wertStr || wertStr === '0') return;

  // Skip fields without page reference
  const pageNum = parsePageNumber(field.quelle);
  if (pageNum === null) return;

  // Check if value is on the reported page
  const pageIndex = pageNum - 1;
  if (pageIndex >= 0 && pageIndex < pageTexts.length) {
    if (fuzzyFindInText(wertStr, pageTexts[pageIndex])) {
      field.verifiziert = true;
      stats.verified++;
      return;
    }
  }

  // Search all other pages
  for (let i = 0; i < pageTexts.length; i++) {
    if (i === pageIndex) continue;
    if (fuzzyFindInText(wertStr, pageTexts[i])) {
      const correctPage = i + 1;
      field.quelle = replacePageNumber(field.quelle, correctPage);
      field.verifiziert = true;
      stats.corrected++;
      logger.info('Seitennummer korrigiert', {
        wert: wertStr.substring(0, 50),
        von: pageNum,
        nach: correctPage,
      });
      return;
    }
  }

  // Value not found on any page
  field.verifiziert = false;
  stats.unreliable++;
  logger.warn('Wert nicht verifizierbar', {
    wert: wertStr.substring(0, 50),
    quelle: field.quelle,
  });
}

/**
 * Verify all page references in an extraction result against actual page texts.
 * Mutates and returns the result.
 *
 * - Values found on correct page → verifiziert: true
 * - Values found on different page → quelle corrected, verifiziert: true
 * - Values not found anywhere → verifiziert: false
 */
export function verifyPageReferences(result: ExtractionResult, pageTexts: string[]): ExtractionResult {
  const stats = { verified: 0, corrected: 0, unreliable: 0 };

  walkAndVerify(result, pageTexts, stats);

  logger.info('Seitenverifizierung abgeschlossen', stats);
  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/utils/__tests__/pageVerifier.test.ts`
Expected: All PASS

**Step 5: Commit**
```bash
git add backend/src/utils/pageVerifier.ts backend/src/utils/__tests__/pageVerifier.test.ts
git commit -m "feat: add verifyPageReferences for post-extraction page verification"
```

---

### Task 6: Update Zod validation to pass through `verifiziert`

**Files:**
- Modify: `backend/src/utils/validation.ts:58-61` (sourcedValueSchema)
- Modify: `backend/src/utils/validation.ts:43-56` (toSourcedValue helper)

**Step 1: Update `toSourcedValue` to preserve `verifiziert`**

In `backend/src/utils/validation.ts`, update the `toSourcedValue` function to carry through the `verifiziert` field:

```typescript
const toSourcedValue = (v: unknown): { wert: string | number | boolean | null; quelle: string; verifiziert?: boolean } => {
  if (v == null) return { wert: null, quelle: '' };
  if (typeof v === 'string') return { wert: v, quelle: '' };
  if (typeof v === 'number' || typeof v === 'boolean') return { wert: v, quelle: '' };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const w = o.wert;
    const result: { wert: string | number | boolean | null; quelle: string; verifiziert?: boolean } = {
      wert: w === null || w === undefined ? null : (w as string | number | boolean),
      quelle: String(o.quelle ?? ''),
    };
    if (typeof o.verifiziert === 'boolean') {
      result.verifiziert = o.verifiziert;
    }
    return result;
  }
  return { wert: null, quelle: '' };
};
```

**Step 2: The schemas already use `.passthrough()` on the z.object**

The existing `sourcedValueSchema`, `sourcedNumberSchema`, and `sourcedBooleanSchema` all use `.passthrough()` — this means extra properties like `verifiziert` will be preserved through validation. No schema changes needed.

**Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**
```bash
git add backend/src/utils/validation.ts
git commit -m "feat: preserve verifiziert field through Zod validation"
```

---

### Task 7: Integrate verification into extraction pipeline

**Files:**
- Modify: `backend/src/services/extraction.ts:1-8` (imports)
- Modify: `backend/src/services/extraction.ts:74-102` (processExtraction body)

**Step 1: Add import**

Add to imports in `backend/src/services/extraction.ts`:
```typescript
import { verifyPageReferences } from '../utils/pageVerifier';
```

**Step 2: Always extract page texts and call verification**

Modify the `processExtraction` function. The key change: always call `extractTextPerPage()` and pass it to `verifyPageReferences()`.

Replace lines 74-104 with:
```typescript
    const pdfBuffer = fs.readFileSync(filePath);

    const pageCount = await getPageCount(pdfBuffer);
    logger.info('PDF Seitenanzahl ermittelt', { pageCount });

    // Always extract text per page — needed for verification
    const pageTexts = await extractTextPerPage(pdfBuffer);

    let result: ExtractionResult;

    if (pageCount > PDF_DOCUMENT_PAGE_LIMIT) {
      // Large PDF: extract text per page and process in chunks
      logger.info('Großes PDF — verwende seitenbasiertes Chunking', { pageCount });
      result = await extractFromPageTexts(pageTexts);
    } else {
      // Small PDF: send as native document for best quality
      try {
        result = await extractFromPdfBuffer(pdfBuffer);
      } catch (primaryError) {
        // Do NOT fall back on rate limit or auth errors — they will fail again
        if (isAnthropicApiError(primaryError)) {
          throw primaryError;
        }
        logger.warn('PDF-Dokument-Modus fehlgeschlagen, versuche seitenbasierten Text-Fallback', {
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        });
        result = await extractFromPageTexts(pageTexts);
      }
    }

    // Verify and correct page references against actual page texts
    result = verifyPageReferences(result, pageTexts);

    result = validateLettersAgainstChecklists(result);
```

**Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**
```bash
git add backend/src/services/extraction.ts
git commit -m "feat: integrate page verification into extraction pipeline"
```

---

### Task 8: Add 'unverified' badge type to frontend

**Files:**
- Modify: `frontend/src/components/extraction/Badge.tsx:1` (BadgeType)
- Modify: `frontend/src/components/extraction/Badge.tsx:3-10` (badgeStyles)

**Step 1: Add 'unverified' badge type**

In `frontend/src/components/extraction/Badge.tsx`:

Update the `BadgeType` to include `'unverified'`:
```typescript
type BadgeType = 'found' | 'missing' | 'partial' | 'bereit' | 'fehlt' | 'entfaellt' | 'unverified';
```

Add the style entry to `badgeStyles`:
```typescript
unverified: { bg: 'bg-ie-amber-bg', text: 'text-ie-amber', border: 'border-ie-amber-border', label: 'UNGEPRÜFT' },
```

**Step 2: Verify frontend builds**

Run: `cd frontend && npm run build`
Expected: No errors (or `npx tsc --noEmit` if build is not configured)

**Step 3: Commit**
```bash
git add frontend/src/components/extraction/Badge.tsx
git commit -m "feat: add unverified badge type for unverifiable fields"
```

---

### Task 9: Update DataField to show verification state

**Files:**
- Modify: `frontend/src/components/extraction/DataField.tsx`

**Step 1: Update DataField component**

In `frontend/src/components/extraction/DataField.tsx`:

Add a helper to get the verifiziert flag (after the existing helper functions, around line 23):
```typescript
function getVerifiziert(field: AnySourced): boolean | undefined {
  if (!field) return undefined;
  if (typeof field === 'object' && 'verifiziert' in field) return (field as any).verifiziert;
  return undefined;
}
```

In the component body, after `const pageNum = ...` (line 47), add:
```typescript
const verifiziert = getVerifiziert(field);
const isUnverified = verifiziert === false;
```

Update the Badge at line 108 — change from:
```tsx
<Badge type={empty ? 'missing' : 'found'} />
```
to:
```tsx
<Badge type={empty ? 'missing' : isUnverified ? 'unverified' : 'found'} />
```

When `isUnverified`, disable page navigation. Update the `handleQuelleClick` function:
```typescript
const handleQuelleClick = () => {
  if (pageNum && totalPages > 0 && !isUnverified) {
    const val = displayValue();
    const textToHighlight = empty || val === '\u2014' ? undefined : val;
    goToPageAndHighlight(pageNum, textToHighlight);
  }
  setShowSrc(!showSrc);
};
```

Update the page badge button styling to show warning state when unverified. Change the className logic for the page badge:
```tsx
{q && (
  <button
    onClick={handleQuelleClick}
    title={isUnverified ? 'Quelle nicht verifiziert' : pageNum ? `Seite ${pageNum} anzeigen` : 'Quelle anzeigen'}
    className={`bg-transparent border rounded-sm text-[8px] px-1.5 py-px cursor-pointer font-mono tracking-wide transition-colors
      ${showSrc
        ? 'border-accent text-accent'
        : isUnverified
          ? 'border-ie-amber-border text-ie-amber'
          : pageNum
            ? 'border-ie-blue-border text-ie-blue hover:border-ie-blue hover:text-ie-blue'
            : 'border-border text-text-muted hover:border-accent hover:text-accent'
      }`}
  >
    {showSrc ? '\u00d7' : isUnverified ? '?' : pageNum ? `S.${pageNum}` : 'Q'}
  </button>
)}
```

**Step 2: Verify frontend builds**

Run: `cd frontend && npm run build` (or `npx tsc --noEmit`)
Expected: No errors

**Step 3: Commit**
```bash
git add frontend/src/components/extraction/DataField.tsx
git commit -m "feat: show unverified state for fields with verifiziert: false"
```

---

### Task 10: Run all tests and verify end-to-end

**Step 1: Run all backend tests**

Run: `cd backend && npx vitest run`
Expected: All tests pass

**Step 2: Verify backend builds**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

**Step 3: Verify frontend builds**

Run: `cd frontend && npm run build` (or `npx tsc --noEmit`)
Expected: No errors

**Step 4: Manual test with a real PDF**

1. Start backend and frontend
2. Upload a PDF
3. Check the extraction result: fields should show green "GEFUNDEN" or amber "UNGEPRÜFT" badges
4. Check logs for "Seitenverifizierung abgeschlossen" with stats
5. Click on a verified "S.X" badge — should navigate to the correct page

**Step 5: Final commit**
```bash
git add -A
git commit -m "feat: post-extraction page verification layer

Adds verification that checks every extracted value's page number
against actual PDF text. Auto-corrects wrong pages silently and
flags unfindable values as unverified."
```
