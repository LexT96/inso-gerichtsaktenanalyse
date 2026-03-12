# Semantic Page Verification — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text-matching page verification with a single Claude Haiku API call that semantically verifies extracted field sources against actual document content.

**Architecture:** After extraction, collect all `{wert, quelle}` fields, send them with page texts to Haiku for semantic verification, apply the results (verifiziert flag + corrected quelle) back onto the ExtractionResult. Graceful degradation if the API call fails.

**Tech Stack:** TypeScript, Anthropic SDK (Haiku 4.5), jsonrepair, vitest

**Spec:** `docs/superpowers/specs/2026-03-12-semantic-verification-design.md`

---

## Chunk 1: Core Implementation

### Task 1: Export shared utilities from anthropic.ts

**Files:**
- Modify: `backend/src/services/anthropic.ts`

- [ ] **Step 1: Export the Anthropic client instance**

In `backend/src/services/anthropic.ts`, change line 8 from:
```typescript
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
```
to:
```typescript
export const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
```

- [ ] **Step 2: Export callWithRetry**

Change line 188 from:
```typescript
async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
```
to:
```typescript
export async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
```

- [ ] **Step 3: Export extractJsonFromText and fix array handling**

Change line 330 from:
```typescript
function extractJsonFromText(text: string): string {
```
to:
```typescript
export function extractJsonFromText(text: string): string {
```

Then fix the "last resort" fallback (lines 340-344) to also handle JSON arrays. Change:
```typescript
  // 3. Last resort: find first { to last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
```
to:
```typescript
  // 3. Last resort: find outermost JSON structure (object or array)
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const start = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace) ? firstBracket : firstBrace;
  const end = lastBracket >= 0 && (lastBrace < 0 || lastBracket > lastBrace) ? lastBracket : lastBrace;
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
```

This is necessary because the semantic verifier expects a JSON **array** response (`[{...}, ...]`), not a JSON object. Without this fix, the fallback would strip the `[` and `]` brackets.

- [ ] **Step 4: Verify build still works**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/services/anthropic.ts
git commit -m "refactor: export anthropic client, callWithRetry, and extractJsonFromText for reuse"
```

---

### Task 2: Create semanticVerifier.ts

**Files:**
- Create: `backend/src/utils/semanticVerifier.ts`

- [ ] **Step 1: Create the semantic verifier module**

Create `backend/src/utils/semanticVerifier.ts` with the following content:

```typescript
/**
 * Semantic page reference verification using Claude Haiku.
 *
 * Replaces the text-matching pageVerifier with a single API call that
 * understands document context and authoritative sources.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { logger } from './logger';
import type { ExtractionResult } from '../types/extraction';

// ─── Types ───

interface SourcedField {
  wert: unknown;
  quelle: string;
  verifiziert?: boolean;
}

interface CollectedField {
  ref: SourcedField;
  path: string;
}

interface VerificationEntry {
  nr: number;
  verifiziert: boolean;
  quelle_korrigiert?: string;
  begruendung?: string;
}

// ─── Field collection ───

function isSourcedField(obj: unknown): obj is SourcedField {
  if (obj === null || obj === undefined || typeof obj !== 'object') return false;
  return 'wert' in obj && 'quelle' in obj;
}

function wertIsEmpty(wert: unknown): boolean {
  if (wert === null || wert === undefined) return true;
  if (typeof wert === 'string') return wert.trim() === '';
  return false;
}

/**
 * Walk an ExtractionResult and collect all {wert, quelle} fields
 * that have non-empty wert values, along with their dot-notation paths.
 */
export function collectFields(obj: unknown, prefix: string = ''): CollectedField[] {
  const fields: CollectedField[] = [];

  if (obj === null || obj === undefined || typeof obj !== 'object') return fields;

  if (isSourcedField(obj)) {
    if (!wertIsEmpty(obj.wert)) {
      fields.push({ ref: obj, path: prefix });
    }
    return fields;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      fields.push(...collectFields(obj[i], `${prefix}[${i}]`));
    }
    return fields;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    fields.push(...collectFields(value, path));
  }

  return fields;
}

// ─── Prompt ───

const VERIFICATION_PROMPT = `Du prüfst extrahierte Daten aus einer deutschen Insolvenzakte.
Für jedes Feld prüfe:
1. Kommt der Wert tatsächlich im Dokument vor?
2. Ist die angegebene Seite korrekt?
3. Ist die Quelle die AUTORITATIVE Fundstelle — nicht bloß irgendeine Erwähnung?

Autoritative Quellen in Insolvenzakten:
- Verfahrensdaten (Aktenzeichen, Gericht, Richter, Beschlussdatum, Antragsart) → Beschluss/Verfügung des Gerichts
- Schuldnerdaten (Name, Adresse, Geburtsdatum, Firma) → Rubrum des Beschlusses oder Insolvenzantrag
- Antragstellerdaten (Name, Adresse, Forderungen) → Insolvenzantrag
- Forderungen (Beträge, Zeiträume) → Insolvenzantrag / Forderungsaufstellung
- Gutachterbestellung → Beschluss zur Gutachterbestellung
- Ermittlungsergebnisse Grundbuch → Grundbuchauskunft/-mitteilung
- Ermittlungsergebnisse Gerichtsvollzieher → Mitteilung des Gerichtsvollziehers
- Ermittlungsergebnisse Meldeauskunft → Meldebehördliche Auskunft
- Ermittlungsergebnisse Vollstreckungsportal → Schuldnerverzeichnis-Auskunft

WICHTIG: Ein Datum, Name oder Betrag kann auf mehreren Seiten vorkommen. Wähle die Seite, auf der der Wert in seinem FACHLICHEN KONTEXT steht — nicht die erste oder zufällige Erwähnung.

Wenn der Wert im Dokument vorkommt und die Quelle korrekt ist → verifiziert: true
Wenn der Wert vorkommt, aber auf einer anderen Seite steht → verifiziert: true + quelle_korrigiert mit korrekter Seitenangabe
Wenn der Wert NICHT im Dokument vorkommt → verifiziert: false + begruendung

Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Markdown, keine Erklärung):
[{"nr": 1, "verifiziert": true}, {"nr": 2, "verifiziert": true, "quelle_korrigiert": "Seite X, Beschluss"}, ...]`;

// ─── Token estimation ───

const MAX_ESTIMATED_TOKENS = 150_000;
const CHARS_PER_TOKEN = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build page text block. If total tokens would exceed the limit,
 * truncate by keeping first and last pages.
 */
function buildPageBlock(pageTexts: string[]): string {
  const fullBlock = pageTexts
    .map((text, i) => `=== SEITE ${i + 1} ===\n${text}`)
    .join('\n\n');

  if (estimateTokens(fullBlock) <= MAX_ESTIMATED_TOKENS) {
    return fullBlock;
  }

  // Keep first 100 + last 100 pages
  const keepFront = 100;
  const keepBack = Math.min(100, pageTexts.length - keepFront);
  const frontPages = pageTexts.slice(0, keepFront);
  const backPages = pageTexts.slice(pageTexts.length - keepBack);
  const omitted = pageTexts.length - keepFront - keepBack;

  logger.warn('Seitentext zu groß für Verifikation, Seiten in der Mitte werden übersprungen', {
    totalPages: pageTexts.length,
    omittedPages: omitted,
  });

  const frontBlock = frontPages
    .map((text, i) => `=== SEITE ${i + 1} ===\n${text}`)
    .join('\n\n');
  const backBlock = backPages
    .map((text, i) => `=== SEITE ${pageTexts.length - keepBack + i + 1} ===\n${text}`)
    .join('\n\n');

  return `${frontBlock}\n\n[... ${omitted} Seiten übersprungen ...]\n\n${backBlock}`;
}

function buildFieldList(fields: CollectedField[]): string {
  return fields
    .map((f, i) => {
      const wert = typeof f.ref.wert === 'string' ? f.ref.wert : String(f.ref.wert);
      return `${i + 1}. ${f.path} | Wert: "${wert}" | Quelle: "${f.ref.quelle}"`;
    })
    .join('\n');
}

// ─── Parse verification response ───

function parseVerificationResponse(text: string): VerificationEntry[] {
  const jsonStr = extractJsonFromText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(jsonStr));
      logger.info('Verifikations-JSON per jsonrepair repariert');
    } catch (err) {
      logger.error('Verifikations-JSON konnte nicht geparst werden', {
        error: err instanceof Error ? err.message : String(err),
        sample: jsonStr.slice(0, 300),
      });
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    logger.error('Verifikations-Antwort ist kein Array');
    return [];
  }

  return parsed.filter(
    (e): e is VerificationEntry =>
      e != null &&
      typeof e === 'object' &&
      typeof (e as VerificationEntry).nr === 'number' &&
      typeof (e as VerificationEntry).verifiziert === 'boolean'
  );
}

// ─── Main ───

/**
 * Semantically verify all page references in an ExtractionResult
 * using a single Claude Haiku API call.
 *
 * For each sourced field with a non-empty wert:
 * - If verified → verifiziert = true
 * - If wrong page → corrects quelle, verifiziert = true
 * - If value not in document → verifiziert = false
 *
 * On API failure: logs warning, returns result unchanged (graceful degradation).
 */
export async function semanticVerify(
  result: ExtractionResult,
  pageTexts: string[]
): Promise<ExtractionResult> {
  const fields = collectFields(result);

  if (fields.length === 0) {
    logger.info('Keine Felder zur Verifikation gefunden');
    return result;
  }

  const pageBlock = buildPageBlock(pageTexts);
  const fieldList = buildFieldList(fields);

  const content = `${VERIFICATION_PROMPT}

--- AKTENINHALT ---

${pageBlock}

--- EXTRAHIERTE FELDER (${fields.length} Stück) ---

${fieldList}`;

  try {
    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001' as const,
        max_tokens: 4096,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    const entries = parseVerificationResponse(text);

    // Apply results
    let verified = 0;
    let corrected = 0;
    let failed = 0;

    for (const entry of entries) {
      const idx = entry.nr - 1;
      if (idx < 0 || idx >= fields.length) continue;

      const field = fields[idx].ref;
      field.verifiziert = entry.verifiziert;

      if (entry.verifiziert) {
        if (entry.quelle_korrigiert) {
          field.quelle = entry.quelle_korrigiert;
          corrected++;
        } else {
          verified++;
        }
      } else {
        failed++;
      }
    }

    const skipped = fields.length - entries.length;

    logger.info('Semantische Verifikation abgeschlossen', {
      total: fields.length,
      verified,
      corrected,
      failed,
      skipped,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  } catch (err) {
    logger.warn('Semantische Verifikation fehlgeschlagen — übersprungen', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
```

- [ ] **Step 2: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd backend
git add src/utils/semanticVerifier.ts
git commit -m "feat: add semantic page verification via Claude Haiku"
```

---

### Task 3: Wire up semanticVerifier in extraction pipeline

**Files:**
- Modify: `backend/src/services/extraction.ts`

- [ ] **Step 1: Replace import**

In `backend/src/services/extraction.ts`, change line 8 from:
```typescript
import { verifyPageReferences } from '../utils/pageVerifier';
```
to:
```typescript
import { semanticVerify } from '../utils/semanticVerifier';
```

- [ ] **Step 2: Replace verification call**

Change line 106 from:
```typescript
    result = verifyPageReferences(result, pageTexts);
```
to:
```typescript
    result = await semanticVerify(result, pageTexts);
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd backend
git add src/services/extraction.ts
git commit -m "feat: switch extraction pipeline to semantic verification"
```

---

### Task 4: Delete old verification files

**Files:**
- Delete: `backend/src/utils/pageVerifier.ts`
- Delete: `backend/src/utils/fuzzyMatch.ts`
- Delete: `backend/src/utils/pageParser.ts`
- Delete: `backend/src/utils/__tests__/pageVerifier.test.ts`
- Delete: `backend/src/utils/__tests__/fuzzyMatch.test.ts`
- Delete: `backend/src/utils/__tests__/pageParser.test.ts`

- [ ] **Step 1: Verify no other imports exist**

Search for any remaining imports of the old modules:
```bash
cd backend && grep -r "pageVerifier\|fuzzyMatch\|pageParser" src/ --include="*.ts" -l
```
Expected: no files (extraction.ts was already updated in Task 3)

- [ ] **Step 2: Delete the files**

```bash
cd backend
rm src/utils/pageVerifier.ts src/utils/fuzzyMatch.ts src/utils/pageParser.ts
rm src/utils/__tests__/pageVerifier.test.ts src/utils/__tests__/fuzzyMatch.test.ts src/utils/__tests__/pageParser.test.ts
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd backend
git add -u src/utils/pageVerifier.ts src/utils/fuzzyMatch.ts src/utils/pageParser.ts \
  src/utils/__tests__/pageVerifier.test.ts src/utils/__tests__/fuzzyMatch.test.ts src/utils/__tests__/pageParser.test.ts
git commit -m "refactor: remove old text-matching verification (pageVerifier, fuzzyMatch, pageParser)"
```

---

## Chunk 2: Tests

### Task 5: Write unit tests for semanticVerifier

**Files:**
- Create: `backend/src/utils/__tests__/semanticVerifier.test.ts`

- [ ] **Step 1: Create the test file**

Create `backend/src/utils/__tests__/semanticVerifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock anthropic service — must be before importing semanticVerifier
const mockCreate = vi.fn();
vi.mock('../../services/anthropic', () => ({
  anthropic: { messages: { create: (...args: unknown[]) => mockCreate(...args) } },
  callWithRetry: <T>(fn: () => Promise<T>) => fn(),
  extractJsonFromText: (text: string) => {
    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first >= 0 && last > first) return text.slice(first, last + 1);
    return text;
  },
}));

import { semanticVerify, collectFields } from '../semanticVerifier';
import type { ExtractionResult } from '../../types/extraction';

// ─── Helpers ───

const sv = (wert: string | null, quelle: string) => ({ wert, quelle });
const sn = (wert: number | null, quelle: string) => ({ wert, quelle });
const sb = (wert: boolean | null, quelle: string) => ({ wert, quelle });

function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    verfahrensdaten: {
      aktenzeichen: sv('73 IN 123/25', 'Seite 1, Beschluss'),
      gericht: sv('Amtsgericht Köln', 'Seite 1, Beschluss'),
      richter: sv('Richter Schmidt', 'Seite 2, Beschluss'),
      antragsdatum: sv(null, ''),
      beschlussdatum: sv('18.12.2025', 'Seite 3, Beschluss'),
      antragsart: sv('', ''),
      eroeffnungsgrund: sv('', ''),
      zustellungsdatum_schuldner: sv('20.12.2025', 'Seite 5, Beschluss'),
    },
    schuldner: {
      name: sv('Mustermann', 'Seite 1, Beschluss'),
      vorname: sv('Max', 'Seite 1, Beschluss'),
      geburtsdatum: sv('', ''), geburtsort: sv('', ''), geburtsland: sv('', ''),
      staatsangehoerigkeit: sv('', ''), familienstand: sv('', ''),
      geschlecht: sv('', ''), aktuelle_adresse: sv('', ''),
      fruehere_adressen: [], firma: sv('', ''), rechtsform: sv('', ''),
      betriebsstaette_adresse: sv('', ''), handelsregisternummer: sv('', ''),
      kinder: [],
    },
    antragsteller: {
      name: sv('', ''), adresse: sv('', ''), ansprechpartner: sv('', ''),
      telefon: sv('', ''), fax: sv('', ''), email: sv('', ''),
      betriebsnummer: sv('', ''), bankverbindung_iban: sv('', ''),
      bankverbindung_bic: sv('', ''),
    },
    forderungen: {
      hauptforderung_beitraege: sn(null, ''), saeumniszuschlaege: sn(null, ''),
      mahngebuehren: sn(null, ''), vollstreckungskosten: sn(null, ''),
      antragskosten: sn(null, ''), gesamtforderung: sn(12345.67, 'Seite 1, Forderung'),
      zeitraum_von: sv('', ''), zeitraum_bis: sv('', ''),
      laufende_monatliche_beitraege: sn(null, ''), betroffene_arbeitnehmer: [],
    },
    gutachterbestellung: {
      gutachter_name: sv('', ''), gutachter_kanzlei: sv('', ''),
      gutachter_adresse: sv('', ''), gutachter_telefon: sv('', ''),
      gutachter_email: sv('', ''), abgabefrist: sv('', ''), befugnisse: [],
    },
    ermittlungsergebnisse: {
      grundbuch: { ergebnis: sv('', ''), grundbesitz_vorhanden: sb(null, ''), datum: sv('', '') },
      gerichtsvollzieher: {
        name: sv('', ''), betriebsstaette_bekannt: sb(null, ''),
        vollstreckungen: sv('', ''), masse_deckend: sb(null, ''),
        vermoegensauskunft_abgegeben: sb(null, ''), haftbefehle: sb(null, ''), datum: sv('', ''),
      },
      vollstreckungsportal: { schuldnerverzeichnis_eintrag: sb(null, ''), vermoegensverzeichnis_eintrag: sb(null, '') },
      meldeauskunft: { meldestatus: sv('', ''), datum: sv('', '') },
    },
    fristen: [],
    standardanschreiben: [],
    fehlende_informationen: [],
    zusammenfassung: '',
    risiken_hinweise: [],
    ...overrides,
  };
}

function mockApiResponse(entries: Array<{ nr: number; verifiziert: boolean; quelle_korrigiert?: string; begruendung?: string }>) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(entries) }],
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
}

// ─── Tests ───

describe('collectFields', () => {
  it('collects fields with non-empty wert', () => {
    const result = makeResult();
    const fields = collectFields(result);
    // Should include: aktenzeichen, gericht, richter, beschlussdatum,
    // zustellungsdatum_schuldner, name, vorname, gesamtforderung = 8
    expect(fields.length).toBe(8);
    expect(fields[0].path).toBe('verfahrensdaten.aktenzeichen');
  });

  it('skips fields with null or empty wert', () => {
    const result = makeResult();
    const fields = collectFields(result);
    const paths = fields.map(f => f.path);
    expect(paths).not.toContain('verfahrensdaten.antragsdatum');
    expect(paths).not.toContain('verfahrensdaten.antragsart');
  });

  it('collects SourcedValue items in arrays', () => {
    const result = makeResult({
      schuldner: {
        ...makeResult().schuldner,
        kinder: [{ wert: 'Anna', quelle: 'Seite 2' } as any],
      },
    });
    const fields = collectFields(result);
    const kinderField = fields.find(f => f.path.includes('kinder'));
    expect(kinderField).toBeDefined();
    expect(kinderField!.ref.wert).toBe('Anna');
  });
});

describe('semanticVerify', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  const pageTexts = [
    'Amtsgericht Köln, Az: 73 IN 123/25\nSchuldner: Max Mustermann',
    'Beschluss vom 18.12.2025\nRichter Schmidt',
    'Zustellungsvermerk\nZugestellt am 20.12.2025',
  ];

  it('sets verifiziert: true for confirmed fields', async () => {
    const result = makeResult();
    mockApiResponse([
      { nr: 1, verifiziert: true },
      { nr: 2, verifiziert: true },
      { nr: 3, verifiziert: true },
      { nr: 4, verifiziert: true },
      { nr: 5, verifiziert: true },
      { nr: 6, verifiziert: true },
      { nr: 7, verifiziert: true },
      { nr: 8, verifiziert: true },
    ]);

    await semanticVerify(result, pageTexts);

    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBe(true);
    expect(result.verfahrensdaten.gericht.verifiziert).toBe(true);
    expect(result.schuldner.name.verifiziert).toBe(true);
  });

  it('corrects quelle when quelle_korrigiert is provided', async () => {
    const result = makeResult();
    mockApiResponse([
      { nr: 1, verifiziert: true },
      { nr: 2, verifiziert: true },
      { nr: 3, verifiziert: true },
      { nr: 4, verifiziert: true, quelle_korrigiert: 'Seite 2, Beschluss vom 18.12.2025' },
      { nr: 5, verifiziert: true, quelle_korrigiert: 'Seite 3, Zustellungsvermerk' },
      { nr: 6, verifiziert: true },
      { nr: 7, verifiziert: true },
      { nr: 8, verifiziert: true },
    ]);

    await semanticVerify(result, pageTexts);

    expect(result.verfahrensdaten.beschlussdatum.verifiziert).toBe(true);
    expect(result.verfahrensdaten.beschlussdatum.quelle).toBe('Seite 2, Beschluss vom 18.12.2025');
    expect(result.verfahrensdaten.zustellungsdatum_schuldner.quelle).toBe('Seite 3, Zustellungsvermerk');
  });

  it('sets verifiziert: false when value not found', async () => {
    const result = makeResult();
    mockApiResponse([
      { nr: 1, verifiziert: true },
      { nr: 2, verifiziert: true },
      { nr: 3, verifiziert: false, begruendung: 'Richter nicht im Dokument gefunden' },
      { nr: 4, verifiziert: true },
      { nr: 5, verifiziert: true },
      { nr: 6, verifiziert: true },
      { nr: 7, verifiziert: true },
      { nr: 8, verifiziert: true },
    ]);

    await semanticVerify(result, pageTexts);

    expect(result.verfahrensdaten.richter.verifiziert).toBe(false);
  });

  it('leaves verifiziert undefined on API failure (graceful degradation)', async () => {
    const result = makeResult();
    mockCreate.mockRejectedValueOnce(new Error('API timeout'));

    await semanticVerify(result, pageTexts);

    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBeUndefined();
    expect(result.schuldner.name.verifiziert).toBeUndefined();
  });

  it('handles malformed API response gracefully', async () => {
    const result = makeResult();
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    await semanticVerify(result, pageTexts);

    // No crash, verifiziert stays undefined
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBeUndefined();
  });

  it('returns the same result object (mutation)', async () => {
    const result = makeResult();
    mockApiResponse([{ nr: 1, verifiziert: true }]);

    const returned = await semanticVerify(result, pageTexts);
    expect(returned).toBe(result);
  });

  it('handles empty fields gracefully (no API call)', async () => {
    const result = makeResult();
    // Clear all fields
    result.verfahrensdaten.aktenzeichen.wert = null;
    result.verfahrensdaten.gericht.wert = null;
    result.verfahrensdaten.richter.wert = null;
    result.verfahrensdaten.beschlussdatum.wert = null;
    result.verfahrensdaten.zustellungsdatum_schuldner.wert = null;
    result.schuldner.name.wert = null;
    result.schuldner.vorname.wert = null;
    result.forderungen.gesamtforderung.wert = null;

    await semanticVerify(result, pageTexts);

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `cd backend && npx vitest run src/utils/__tests__/semanticVerifier.test.ts`
Expected: all tests pass

- [ ] **Step 3: Run the full test suite**

Run: `cd backend && npx vitest run`
Expected: all tests pass (old test files were deleted in Task 4)

- [ ] **Step 4: Commit**

```bash
cd backend
git add src/utils/__tests__/semanticVerifier.test.ts
git commit -m "test: add unit tests for semantic verification"
```

---

## Chunk 3: Verification and Cleanup

### Task 6: Verify build and run full test suite

- [ ] **Step 1: TypeScript compilation check**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Full test suite**

Run: `cd backend && npx vitest run`
Expected: all tests pass

- [ ] **Step 3: Verify verify script still works**

Run: `cd backend && npm run verify -- --id=1 2>&1 | head -20`
Expected: runs without import errors (may fail on missing DB record, which is fine — we're checking the import chain works)

---

### Task 7: Integration test with real PDF (manual)

- [ ] **Step 1: Run extraction with verification**

Run: `cd backend && npm run verify -- ../standardschreiben/Bankenanfrage.pdf`
Expected: extraction completes, verification results appear in output showing verified/corrected/failed counts

- [ ] **Step 2: Review output**

Check that:
- Fields have `verifiziert: true` where values match
- `quelle` references point to the correct document sections
- No fields are spuriously `verifiziert: false` for values that exist in the document
