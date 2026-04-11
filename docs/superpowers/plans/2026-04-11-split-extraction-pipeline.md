# Split Extraction Pipeline — Focused Passes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic extraction call with focused per-domain passes so tables and creditor lists are extracted completely, without late-array degradation.

**Architecture:** The single `extractComprehensive()` Sonnet call (which extracts 50+ field types simultaneously) is split into: (1) a Base pass (Sonnet, scalar fields only), (2) a Forderungen pass (Haiku, creditor pages), (3) Aktiva pass (Haiku, already exists), (4) Anfechtung pass (Haiku, already exists). The document analyzer's existing segments route only relevant pages to each focused pass. All arithmetic stays in deterministic post-processing (Tier 1 changes already merged).

**Tech Stack:** TypeScript, Anthropic SDK, Zod validation, existing pipeline infrastructure

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/services/anthropic.ts` | Modify | Trim `EXTRACTION_PROMPT` to scalar fields only (remove forderungen/aktiva/anfechtung sections). Export trimmed prompt. Keep `extractComprehensive()` and `extractFromPageTexts()` working with trimmed prompt. |
| `backend/src/utils/forderungenExtractor.ts` | Create | Focused Haiku extractor for `Forderungen` (einzelforderungen, betroffene_arbeitnehmer). Modeled on `aktivaExtractor.ts`. |
| `backend/src/utils/documentAnalyzer.ts` | Modify | Add `classifySegmentsForExtraction()` helper that tags segments as relevant for `forderungen`, `aktiva`, `anfechtung`, or `base`. |
| `backend/src/services/extraction.ts` | Modify | Rewire `processExtraction()` to use multi-pass: base → parallel(forderungen, aktiva, anfechtung) → merge → verify → handwriting → enrichment → postProcess. |
| `backend/src/utils/aktivaExtractor.ts` | Minor modify | No prompt changes needed (Tier 1 already done). Just ensure it works when called with subset of pages. |
| `backend/src/utils/anfechtungsAnalyzer.ts` | Minor modify | Same — ensure subset-page support. |

---

### Task 1: Add page routing to documentAnalyzer

**Files:**
- Modify: `backend/src/utils/documentAnalyzer.ts`

- [ ] **Step 1: Add the segment classification function**

Add after `findOrphanPages()` (after line 160):

```typescript
/**
 * Classify document segments by extraction domain.
 * Returns page numbers relevant for each focused extractor.
 * Pages can appear in multiple domains (e.g. a page with both creditor and asset info).
 */
export interface ExtractionRouting {
  /** Pages relevant for forderungen/creditor extraction */
  forderungenPages: number[];
  /** Pages relevant for aktiva/asset extraction */
  aktivaPages: number[];
  /** Pages relevant for anfechtung/contestable transactions */
  anfechtungPages: number[];
}

// Keywords in segment type or description that indicate domain relevance
const FORDERUNGEN_KEYWORDS = /forderung|gläubiger|glaub|kredit|verbindlich|darlehen|wandel|schuld|sozialversicherung|finanzamt|steuer|arbeitnehmer|lohn|gehalt|insolvenzantrag|antragsteller|tabelle|passiva/i;
const AKTIVA_KEYWORDS = /aktiva|vermögen|bilanz|grundbuch|grundstück|immobili|fahrzeug|kfz|pkw|konto|bank|guthaben|versicherung|forderung.*schuldner|inventar|anlage|sachlage|vorräte|geschäftsausstattung|maschine|wertpapier/i;
const ANFECHTUNG_KEYWORDS = /anfechtung|zahlung|überweisung|transaktion|schenkung|gesellschafterdarlehen|nahestehend|§\s*1[3-4]\d|vorsätzlich|unentgeltlich|deckung|kongruent|inkongruent/i;

export function classifySegmentsForExtraction(
  segments: DocumentSegment[],
  totalPages: number,
): ExtractionRouting {
  const forderungenPages = new Set<number>();
  const aktivaPages = new Set<number>();
  const anfechtungPages = new Set<number>();

  for (const seg of segments) {
    const text = `${seg.type} ${seg.description}`.toLowerCase();
    if (FORDERUNGEN_KEYWORDS.test(text)) {
      for (const p of seg.pages) forderungenPages.add(p);
    }
    if (AKTIVA_KEYWORDS.test(text)) {
      for (const p of seg.pages) aktivaPages.add(p);
    }
    if (ANFECHTUNG_KEYWORDS.test(text)) {
      for (const p of seg.pages) anfechtungPages.add(p);
    }
  }

  // Fallback: if no pages matched for a domain, include all pages
  // (better to send too much than miss data)
  const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  return {
    forderungenPages: forderungenPages.size > 0 ? [...forderungenPages].sort((a, b) => a - b) : allPages,
    aktivaPages: aktivaPages.size > 0 ? [...aktivaPages].sort((a, b) => a - b) : allPages,
    anfechtungPages: anfechtungPages.size > 0 ? [...anfechtungPages].sort((a, b) => a - b) : allPages,
  };
}
```

- [ ] **Step 2: Verify build**

Run: `cd backend && npm run build`
Expected: clean compile

- [ ] **Step 3: Commit**

```bash
git add backend/src/utils/documentAnalyzer.ts
git commit -m "feat: add segment classification for multi-pass extraction routing"
```

---

### Task 2: Create forderungenExtractor

**Files:**
- Create: `backend/src/utils/forderungenExtractor.ts`

- [ ] **Step 1: Create the focused forderungen extractor**

Create `backend/src/utils/forderungenExtractor.ts`. Model after `aktivaExtractor.ts` — same pattern: Zod schema, focused prompt, Haiku call, JSON parse with jsonrepair fallback, graceful degradation.

The prompt must be narrow: ONLY extract einzelforderungen and betroffene_arbeitnehmer. No scalar fields, no aktiva, no anfechtung.

```typescript
/**
 * Forderungen/Creditor extraction — focused Haiku pass.
 *
 * Extracts einzelforderungen (creditor claims) and betroffene_arbeitnehmer
 * from creditor-relevant pages. Runs in parallel with aktiva/anfechtung.
 *
 * Graceful degradation: returns null on any failure so the pipeline
 * continues without forderungen data (base extraction may still have partial data).
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import type { Forderungen } from '../types/extraction';

// ─── Zod schemas ───

const sourcedValueSchema = z.object({
  wert: z.preprocess(
    (v) => (v === undefined ? null : v),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  ),
  quelle: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string()
  ),
});

const sourcedNumberSchema = z.object({
  wert: z.preprocess(
    (v) => {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const cleaned = v.replace(/\./g, '').replace(',', '.');
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
      }
      return null;
    },
    z.number().nullable()
  ),
  quelle: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string()
  ),
});

const einzelforderungSchema = z.object({
  glaeubiger: sourcedValueSchema,
  art: z.preprocess((v) => String(v ?? 'sonstige'), z.string()),
  rang: z.preprocess((v) => String(v ?? '§38 Insolvenzforderung'), z.string()),
  betrag: sourcedNumberSchema,
  zeitraum_von: sourcedValueSchema.optional(),
  zeitraum_bis: sourcedValueSchema.optional(),
  titel: sourcedValueSchema,
  sicherheit: z.any().optional(),
  ist_antragsteller: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional(),
});

const forderungenSchema = z.object({
  einzelforderungen: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(einzelforderungSchema)
  ),
  gesamtforderungen: sourcedNumberSchema.optional(),
  gesicherte_forderungen: sourcedNumberSchema.optional(),
  ungesicherte_forderungen: sourcedNumberSchema.optional(),
  betroffene_arbeitnehmer: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(z.any())
  ).optional(),
});

// ─── Prompt ───

const FORDERUNGEN_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter. Extrahiere ALLE Forderungen/Verbindlichkeiten aus den folgenden Seiten.

PFLICHT: Jedes Feld mit ausgefülltem "wert" MUSS eine "quelle" haben. Format: "Seite X, [Dokument/Abschnitt]".
Datumsformat: TT.MM.JJJJ. Beträge: IMMER als reine Zahl ohne Tausendertrennzeichen (z.B. 100000.00 NICHT 100.000,00).

ABSOLUTES VERBOT — Beträge NIEMALS selbst berechnen: Wenn eine Forderung aus Teilbeträgen besteht (z.B. Nennbetrag + Zinsen bei Wandeldarlehen, oder Hauptforderung + Nebenforderungen), setze betrag auf NULL. Trage die Komponenten NUR in das titel-Feld ein, z.B. "Wandeldarlehen: Nennbetrag 50.000,00 EUR; Zinsen 1.791,67 EUR". Die Berechnung der Summe erfolgt automatisch im System. Setze betrag NUR dann, wenn ein einzelner EXPLIZITER Gesamtbetrag im Dokument steht.

WICHTIG — glaeubiger ist IMMER ein Name: Das Feld glaeubiger.wert MUSS der Name einer Person, Firma oder Organisation sein. NIEMALS Beträge, Seitenreferenzen oder Datumsangaben als Gläubigernamen eintragen.

WICHTIG — VOLLSTÄNDIGKEIT: Extrahiere JEDEN einzelnen Gläubiger/Forderung. Bei langen Tabellen (z.B. 15+ Wandeldarlehen) MÜSSEN ALLE Einträge extrahiert werden — auch die letzten. Zähle die Einträge in der Tabelle und vergleiche mit deiner Ausgabe.

Für jeden Gläubiger erstelle ein einzelnes Objekt:
- glaeubiger: Name der Person/Firma/Organisation
- art: "sozialversicherung"|"steuer"|"bank"|"lieferant"|"arbeitnehmer"|"miete"|"sonstige"
- rang: "§38 Insolvenzforderung"|"§39 Nachrangig"|"Masseforderung §55"
- betrag: Nur expliziter Gesamtbetrag aus dem Dokument, sonst null
- titel: Beschreibung inkl. Aufschlüsselung (z.B. "Nennbetrag 50.000,00 EUR; Zinsen 1.791,67 EUR")
- sicherheit: Nur wenn eine konkrete Sicherheit genannt ist
- ist_antragsteller: true wenn dieser Gläubiger den Insolvenzantrag gestellt hat

Für betroffene_arbeitnehmer: Extrahiere alle namentlich oder zahlenmäßig genannten betroffenen Arbeitnehmer als Objekte mit {anzahl, typ, quelle}.

gesamtforderungen, gesicherte_forderungen, ungesicherte_forderungen: Auf null setzen — werden automatisch berechnet.

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks):
{
  "einzelforderungen": [
    {
      "glaeubiger": {"wert": "Name", "quelle": "Seite X"},
      "art": "sonstige",
      "rang": "§38 Insolvenzforderung",
      "betrag": {"wert": null, "quelle": ""},
      "titel": {"wert": "Beschreibung mit Teilbeträgen", "quelle": "Seite X"},
      "ist_antragsteller": false
    }
  ],
  "gesamtforderungen": {"wert": null, "quelle": ""},
  "gesicherte_forderungen": {"wert": null, "quelle": ""},
  "ungesicherte_forderungen": {"wert": null, "quelle": ""},
  "betroffene_arbeitnehmer": []
}`;

// ─── Main ───

export async function extractForderungen(
  pageTexts: string[],
  relevantPages: number[] | undefined,
  documentMap: string | undefined,
): Promise<Forderungen | null> {
  try {
    // Use only relevant pages if routing is available, otherwise all pages
    const pages = relevantPages ?? pageTexts.map((_, i) => i + 1);
    logger.info('Forderungen-Extraktion gestartet', { totalPages: pageTexts.length, relevantPages: pages.length });

    const mapBlock = documentMap
      ? `\n--- STRUKTURÜBERSICHT (nur zur Orientierung) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
      : '';

    // Build page block with only relevant pages, but keep original page numbers for source references
    const pageBlock = pages
      .map((pageNum) => `=== SEITE ${pageNum} ===\n${pageTexts[pageNum - 1] ?? ''}`)
      .join('\n\n');

    const content = `${FORDERUNGEN_PROMPT}${mapBlock}\n--- AKTENINHALT (${pages.length} relevante Seiten von ${pageTexts.length} gesamt) ---\n\n${pageBlock}`;

    const model = config.UTILITY_MODEL || 'claude-haiku-4-5-20251001';

    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model,
        max_tokens: 16384,
        temperature: 0,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    // Parse JSON response
    const jsonStr = extractJsonFromText(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      try {
        const repaired = jsonrepair(jsonStr);
        parsed = JSON.parse(repaired);
        logger.info('Forderungen-JSON per jsonrepair repariert');
      } catch (repairErr) {
        logger.error('Forderungen-JSON konnte nicht geparst werden', {
          error: repairErr instanceof Error ? repairErr.message : String(repairErr),
          sample: jsonStr.slice(0, 300),
        });
        return null;
      }
    }

    // Validate with Zod schema
    const result = forderungenSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 5);
      logger.warn('Forderungen-Schema-Validierung: Abweichungen', {
        issueCount: result.error.issues.length,
        paths: issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
      return (parsed ?? null) as Forderungen | null;
    }

    const forderungen = result.data as unknown as Forderungen;

    logger.info('Forderungen-Extraktion abgeschlossen', {
      einzelforderungen: forderungen.einzelforderungen.length,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    return forderungen;
  } catch (err) {
    logger.error('Forderungen-Extraktion fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd backend && npm run build`
Expected: clean compile

- [ ] **Step 3: Commit**

```bash
git add backend/src/utils/forderungenExtractor.ts
git commit -m "feat: add focused forderungen extractor with Haiku"
```

---

### Task 3: Trim the base extraction prompt

**Files:**
- Modify: `backend/src/services/anthropic.ts`

The `EXTRACTION_PROMPT` currently has ~305 lines covering everything. We need to remove the forderungen-specific instructions and the aktiva/anfechtung rules since those are now handled by focused passes. Keep: verfahrensdaten, schuldner, antragsteller, ermittlungsergebnisse, gutachterbestellung, fristen, standardanschreiben, fehlende_informationen, zusammenfassung, risiken_hinweise.

- [ ] **Step 1: Remove forderungen detail instructions from EXTRACTION_PROMPT**

In `anthropic.ts`, locate the forderungen-related instruction blocks (lines ~293-304) and replace with a minimal stub. The base pass should still extract a basic forderungen structure (so standardanschreiben can reference it), but the heavy einzelforderungen work moves to the focused pass.

Replace the forderungen detail block (starting at "Für einzelforderungen: Erstelle für JEDE" through "laufende monatliche Beiträge") with:

```
Für einzelforderungen: Erstelle nur eine GROBE Übersicht — die detaillierte Extraktion aller Einzelforderungen erfolgt in einem separaten Analyseschritt. Trage hier nur den Antragsteller (mit ist_antragsteller: true) und offensichtliche Hauptforderungen ein. Keine Vollständigkeit nötig.
```

- [ ] **Step 2: Remove aktiva/anfechtung rules from EXTRACTION_PROMPT**

Remove the `REGELN FÜR AKTIVA` block (lines ~317-332) and `REGELN FÜR ANFECHTUNG` block (lines ~334-345). Replace both with:

```
REGELN FÜR AKTIVA: Die detaillierte Aktiva-Analyse erfolgt in einem separaten Schritt. Trage hier nur offensichtliche Vermögenswerte ein, die du beim Lesen direkt findest. Keine Vollständigkeit nötig. summe_aktiva auf null setzen.

REGELN FÜR ANFECHTUNG: Die detaillierte Anfechtungsanalyse erfolgt in einem separaten Schritt. Trage hier nur offensichtliche anfechtbare Vorgänge ein. gesamtpotenzial auf null setzen.
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: clean compile

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/anthropic.ts
git commit -m "feat: trim base extraction prompt — forderungen/aktiva/anfechtung move to focused passes"
```

---

### Task 4: Rewire processExtraction to multi-pass

**Files:**
- Modify: `backend/src/services/extraction.ts`

This is the core change. Replace the single `extractComprehensive()` path with: base → parallel(forderungen, aktiva, anfechtung) → merge → rest of pipeline.

- [ ] **Step 1: Add imports**

At the top of `extraction.ts`, add:

```typescript
import { extractForderungen } from '../utils/forderungenExtractor';
import { classifySegmentsForExtraction } from '../utils/documentAnalyzer';
```

- [ ] **Step 2: Rewire the normal extraction path (pageCount <= threshold)**

In `processExtraction()`, replace the block at lines ~619-624:

```typescript
    } else if (pageCount <= effectiveThreshold()) {
      // Anthropic/Vertex/Langdock — uses Anthropic SDK (direct, Vertex, or proxy)
      // Native PDF mode for anthropic + vertex; text mode for langdock
      // Single comprehensive call — extracts base data + aktiva + anfechtung
      report(`Vollständige Analyse (${pageCount} S.)… (Stufe 2/3)`, 35);
      result = await extractComprehensive(pdfBuffer, pageTexts, documentMap);
    }
```

With the multi-pass approach:

```typescript
    } else if (pageCount <= effectiveThreshold()) {
      // Multi-pass extraction: base (Sonnet) + focused passes (Haiku) in parallel
      report(`Basisanalyse (${pageCount} S.)… (Stufe 2a/3)`, 35);
      result = await extractComprehensive(pdfBuffer, pageTexts, documentMap);

      // Classify pages by domain for focused extraction
      const routing = classifySegmentsForExtraction(segments, pageCount);
      logger.info('Seitenklassifizierung', {
        forderungenPages: routing.forderungenPages.length,
        aktivaPages: routing.aktivaPages.length,
        anfechtungPages: routing.anfechtungPages.length,
      });

      // Run focused extractors in parallel (all use cheap Haiku)
      report('Detailanalyse (Forderungen, Aktiva, Anfechtung)… (Stufe 2b/3)', 50);

      if (isRateLimitedProvider()) {
        // Rate-limited: serialize with delays
        logger.info('Rate-limited provider: Detailanalysen seriell');
        const forderungenResult = await extractForderungen(pageTexts, routing.forderungenPages, documentMap)
          .catch(err => { logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });
        await new Promise(r => setTimeout(r, 62_000));
        const aktivaResult = await extractAktiva(pageTexts, documentMap, result)
          .catch(err => { logger.warn('Aktiva-Extraktion fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });
        await new Promise(r => setTimeout(r, 62_000));
        const anfechtungResult = await analyzeAnfechtung(pageTexts, documentMap, result)
          .catch(err => { logger.warn('Anfechtungsanalyse fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });

        if (forderungenResult) result.forderungen = forderungenResult;
        if (aktivaResult) result.aktiva = aktivaResult;
        if (anfechtungResult) result.anfechtung = anfechtungResult;
      } else {
        // Normal: run all three in parallel
        const [forderungenResult, aktivaResult, anfechtungResult] = await Promise.allSettled([
          extractForderungen(pageTexts, routing.forderungenPages, documentMap),
          extractAktiva(pageTexts, documentMap, result),
          analyzeAnfechtung(pageTexts, documentMap, result),
        ]);

        if (forderungenResult.status === 'fulfilled' && forderungenResult.value) {
          result.forderungen = forderungenResult.value;
        } else if (forderungenResult.status === 'rejected') {
          logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: forderungenResult.reason instanceof Error ? forderungenResult.reason.message : String(forderungenResult.reason) });
        }
        if (aktivaResult.status === 'fulfilled' && aktivaResult.value) {
          result.aktiva = aktivaResult.value;
        } else if (aktivaResult.status === 'rejected') {
          logger.warn('Aktiva-Extraktion fehlgeschlagen', { error: aktivaResult.reason instanceof Error ? aktivaResult.reason.message : String(aktivaResult.reason) });
        }
        if (anfechtungResult.status === 'fulfilled' && anfechtungResult.value) {
          result.anfechtung = anfechtungResult.value;
        } else if (anfechtungResult.status === 'rejected') {
          logger.warn('Anfechtungsanalyse fehlgeschlagen', { error: anfechtungResult.reason instanceof Error ? anfechtungResult.reason.message : String(anfechtungResult.reason) });
        }
      }
    }
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: clean compile

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/extraction.ts
git commit -m "feat: rewire extraction to multi-pass — base(Sonnet) + focused(Haiku) in parallel"
```

---

### Task 5: Build, test, and validate with real PDF

**Files:**
- No new files — validation only

- [ ] **Step 1: Full build**

Run: `cd backend && npm run build`
Expected: clean compile, no errors

- [ ] **Step 2: Run tests**

Run: `cd backend && npm run test`
Expected: all existing tests pass (61 tests)

- [ ] **Step 3: Run extraction on the test PDF**

Start the backend dev server, upload the test PDF (`Gerichtsakte__gutes_Beispiel_[9191202]-83-94.pdf`), and verify:

1. All 15 Wandeldarlehen creditors are extracted with correct names (including TKrauss, Untermotorisiert, VAFM)
2. All TEUR creditors (Lohnsteuer, Umsatzsteuer, SV, Kreditkarten) have betrag values
3. `summe_aktiva`, `gesamtforderungen`, `gesamtpotenzial` are all computed by post-processing (quelle says "Berechnet aus...")
4. `freie_masse` is computed for each aktiva position
5. No page references appear as creditor names

- [ ] **Step 4: Compare with baseline extraction #103**

Run the comparison script from the current session to verify improvements:
- More einzelforderungen with betrag values
- All creditor names are actual names (not page references)
- Totals are deterministic

- [ ] **Step 5: Commit any fixes**

If validation reveals issues, fix and commit.
