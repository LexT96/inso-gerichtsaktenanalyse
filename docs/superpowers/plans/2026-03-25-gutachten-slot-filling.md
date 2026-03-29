# Gutachten Slot-Filling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ~100 `[…]` placeholders in Gutachten DOCX templates with data from ExtractionResult via a Claude API call, showing the user a preview to edit before final DOCX generation.

**Architecture:** Two-step flow: (1) `prepare` extracts numbered slots from the template, sends them to Claude with extraction data, returns filled slots as JSON; (2) `generate` applies user-reviewed slot values into the DOCX and returns the file. The paragraph-flattening logic from `replaceFieldsInXml` is extracted into a shared helper used by both FELD_* and slot replacement.

**Tech Stack:** Express, PizZip, Anthropic SDK (Haiku), React 18, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-25-gutachten-slot-filling-design.md`

---

### Task 1: Extract `processDocxParagraphs` helper from `gutachtenGenerator.ts`

Refactor the paragraph-flattening logic into a reusable function so both FELD_* replacement and slot operations can use it.

**Files:**
- Modify: `backend/src/utils/gutachtenGenerator.ts`

- [ ] **Step 1: Extract the shared helper**

Add this function before `replaceFieldsInXml`:

```typescript
/**
 * Process each <w:p> paragraph in DOCX XML. For each paragraph, concatenates
 * all <w:t> text, passes it to transformFn, then writes the result back into
 * the first <w:t> and empties all others. Handles Word's run-splitting.
 */
export function processDocxParagraphs(
  xml: string,
  shouldProcess: (fullText: string) => boolean,
  transformFn: (fullText: string) => string
): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const textParts: { full: string; text: string }[] = [];
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let match;
    while ((match = tRegex.exec(paragraph)) !== null) {
      textParts.push({ full: match[0], text: match[1] });
    }

    if (textParts.length === 0) return paragraph;

    const fullText = textParts.map(p => p.text).join('');

    if (!shouldProcess(fullText)) return paragraph;

    const replaced = transformFn(fullText);

    let result = paragraph;
    let firstDone = false;
    for (const part of textParts) {
      if (!firstDone) {
        result = result.replace(
          part.full,
          () => `<w:t xml:space="preserve">${escapeXml(replaced)}</w:t>`
        );
        firstDone = true;
      } else {
        result = result.replace(part.full, () => '<w:t></w:t>');
      }
    }

    return result;
  });
}
```

Also export `escapeXml` so `gutachtenSlotFiller.ts` can use it.

- [ ] **Step 2: Refactor `replaceFieldsInXml` to use the helper**

Replace the body of `replaceFieldsInXml` with:

```typescript
function replaceFieldsInXml(xml: string, replacements: Record<string, string>): string {
  const sortedKeys = Object.keys(replacements).sort((a, b) => b.length - a.length);

  return processDocxParagraphs(
    xml,
    (text) => text.includes('FELD_'),
    (text) => {
      let replaced = text;
      for (const key of sortedKeys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped + '(?:_\\d+)?', 'g');
        replaced = replaced.replace(regex, replacements[key] ?? '');
      }
      replaced = replaced.replace(/FELD_[\w\u00C0-\u024F]+/g, '');
      return replaced;
    }
  );
}
```

- [ ] **Step 3: Verify backend compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run tests**

Run: `cd backend && npm run test`
Expected: 61 tests pass (same as before)

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/gutachtenGenerator.ts
git commit -m "refactor: extract processDocxParagraphs helper for shared paragraph-flattening"
```

---

### Task 2: Create `gutachtenSlotFiller.ts` with `extractSlots` and `applySlots`

**Files:**
- Create: `backend/src/utils/gutachtenSlotFiller.ts`

- [ ] **Step 1: Create the slot filler module**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import { processDocxParagraphs, escapeXml } from './gutachtenGenerator';
import type { ExtractionResult } from '../types/extraction';

// --- Types ---

export interface SlotInfo {
  id: string;
  context: string;
  original: string;
}

export interface GutachtenSlot extends SlotInfo {
  value: string;
  status: 'filled' | 'todo' | 'editorial';
}

// --- Slot Patterns ---

const SLOT_REGEX = /\[\u2026\]|\[\.{3}\]|\[(?!TODO:)[^\[\]]{1,80}\]|\bx{4,}\b/gi;

function hasSlotPattern(text: string): boolean {
  SLOT_REGEX.lastIndex = 0;
  return SLOT_REGEX.test(text);
}

// --- Extract Slots ---

export function extractSlots(xml: string): { xml: string; slots: SlotInfo[] } {
  const slots: SlotInfo[] = [];
  let counter = 0;

  const resultXml = processDocxParagraphs(
    xml,
    (text) => hasSlotPattern(text),
    (text) => {
      // Reset regex for each paragraph
      const regex = /\[\u2026\]|\[\.{3}\]|\[(?!TODO:)[^\[\]]{1,80}\]|\bx{4,}\b/gi;
      return text.replace(regex, (match) => {
        counter++;
        const id = `SLOT_${String(counter).padStart(3, '0')}`;
        // Context: the full paragraph text with the slot marker inserted
        // We'll capture the surrounding text after all replacements in this paragraph
        slots.push({ id, context: '', original: match });
        return `[[${id}]]`;
      });
    }
  );

  // Second pass: extract context for each slot from the modified XML
  processDocxParagraphs(
    resultXml,
    (text) => text.includes('[[SLOT_'),
    (text) => {
      // Find all slot IDs in this paragraph and update their context
      const slotIdRegex = /\[\[SLOT_(\d{3})\]\]/g;
      let m;
      while ((m = slotIdRegex.exec(text)) !== null) {
        const idx = parseInt(m[1], 10) - 1;
        if (idx >= 0 && idx < slots.length) {
          // Trim context to ~120 chars around the slot
          const pos = m.index;
          const start = Math.max(0, pos - 60);
          const end = Math.min(text.length, pos + m[0].length + 60);
          slots[idx].context = text.slice(start, end).trim();
        }
      }
      return text; // Don't modify
    }
  );

  return { xml: resultXml, slots };
}

// --- Apply Slots ---

export function applySlots(
  xml: string,
  filledSlots: { id: string; value: string }[]
): string {
  const slotMap = new Map(filledSlots.map(s => [s.id, s.value]));

  return processDocxParagraphs(
    xml,
    (text) => text.includes('[[SLOT_'),
    (text) => {
      return text.replace(/\[\[SLOT_\d{3}\]\]/g, (match) => {
        const id = match.slice(2, -2); // Remove [[ and ]]
        return slotMap.get(id) ?? match;
      });
    }
  );
}

// --- Flatten ExtractionResult to .wert values only ---

function flattenResult(result: ExtractionResult): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  function walk(obj: unknown, prefix: string): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      flat[prefix] = obj.map(item => {
        if (item && typeof item === 'object' && 'wert' in item) return (item as { wert: unknown }).wert;
        return item;
      });
      return;
    }
    const o = obj as Record<string, unknown>;
    if ('wert' in o) {
      flat[prefix] = o.wert;
      return;
    }
    for (const [key, val] of Object.entries(o)) {
      if (key === 'quelle' || key === 'verifiziert' || key === 'pruefstatus') continue;
      walk(val, prefix ? `${prefix}.${key}` : key);
    }
  }

  walk(result.verfahrensdaten, 'verfahrensdaten');
  walk(result.schuldner, 'schuldner');
  walk(result.antragsteller, 'antragsteller');
  walk(result.forderungen, 'forderungen');
  walk(result.gutachterbestellung, 'gutachterbestellung');
  walk(result.ermittlungsergebnisse, 'ermittlungsergebnisse');

  if (result.aktiva) {
    const aktiva = result.aktiva;
    flat['aktiva.summe_aktiva'] = aktiva.summe_aktiva?.wert;
    flat['aktiva.massekosten_schaetzung'] = aktiva.massekosten_schaetzung?.wert;
    flat['aktiva.positionen'] = aktiva.positionen.map(p => ({
      beschreibung: p.beschreibung?.wert,
      geschaetzter_wert: p.geschaetzter_wert?.wert,
      kategorie: p.kategorie,
    }));
    if (aktiva.insolvenzanalyse) {
      flat['aktiva.insolvenzanalyse'] = aktiva.insolvenzanalyse;
    }
  }

  return flat;
}

// --- Fill Slots via Claude API ---

const SLOT_FILL_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter. Du erhältst eine Liste nummerierter Platzhalter (Slots) aus einer Gutachten-Vorlage, zusammen mit dem Kontext (umgebender Satz) und extrahierten Daten aus der Gerichtsakte.

Deine Aufgabe: Fülle jeden Slot mit dem passenden Wert aus den bereitgestellten Daten.

REGELN:
- Nur Werte aus den bereitgestellten Daten verwenden, NICHTS erfinden.
- Datumsformat: TT.MM.JJJJ. Beträge: deutsche Schreibweise (1.234,56 EUR).
- Wenn ein Slot aus den Daten NICHT füllbar ist: "[TODO: kurze Beschreibung was hier einzutragen ist]"
- Redaktionelle Anweisungen (erkennbar an "wenn...", "ggf.", "ansonsten", "falls", Hinweise an den Anwalt): "[TODO: ...]" mit dem Originaltext als Hinweis
- "xxxx"-Platzhalter für zukünftige Daten: "[TODO: Datum/Wert eintragen]"
- "[Tabelle]"-Platzhalter: "[TODO: Tabelle einfügen]"

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks):
{"SLOT_001": "Wert", "SLOT_002": "[TODO: Beschreibung]", ...}`;

export async function fillSlots(
  slots: SlotInfo[],
  result: ExtractionResult
): Promise<GutachtenSlot[]> {
  if (slots.length === 0) return [];

  const flatData = flattenResult(result);

  const slotList = slots.map(s =>
    `${s.id}: Kontext="${s.context}" Original="${s.original}"`
  ).join('\n');

  const content = `${SLOT_FILL_PROMPT}

--- EXTRAHIERTE DATEN ---
${JSON.stringify(flatData, null, 2)}

--- SLOTS ZUM FÜLLEN (${slots.length} Stück) ---
${slotList}`;

  const model = config.UTILITY_MODEL || 'claude-haiku-4-5-20251001';

  try {
    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model,
        max_tokens: 8192,
        temperature: 0.1,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    let parsed: Record<string, string>;
    try {
      const jsonStr = extractJsonFromText(text);
      parsed = JSON.parse(jsonStr);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(text));
      } catch {
        logger.error('Slot-Fill JSON parse failed', { sample: text.slice(0, 300) });
        parsed = {};
      }
    }

    logger.info('Slot-Filling completed', {
      total: slots.length,
      filled: Object.keys(parsed).length,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    return slots.map(s => {
      const value = parsed[s.id] ?? '';
      let status: 'filled' | 'todo' | 'editorial';
      if (value.startsWith('[TODO:')) {
        // Distinguish editorial (original was a long instruction) from data gaps
        status = s.original.length > 20 && /wenn|ggf|ansonsten|falls|außerdem/i.test(s.original)
          ? 'editorial'
          : 'todo';
      } else if (value) {
        status = 'filled';
      } else {
        status = 'todo';
        return { ...s, value: `[TODO: ${s.original}]`, status };
      }
      return { ...s, value, status };
    });
  } catch (err) {
    logger.error('Slot-Filling API call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Graceful degradation: return all slots as TODO
    return slots.map(s => ({
      ...s,
      value: `[TODO: ${s.original}]`,
      status: 'todo' as const,
    }));
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/utils/gutachtenSlotFiller.ts
git commit -m "feat: add gutachtenSlotFiller with extractSlots, applySlots, fillSlots"
```

---

### Task 3: Refactor `gutachtenGenerator.ts` to expose `prepareGutachten` and `generateGutachtenFinal`

**Files:**
- Modify: `backend/src/utils/gutachtenGenerator.ts`

- [ ] **Step 1: Replace `generateGutachten` with two new functions**

Keep all existing code (types, getByPath, computed fields, buildReplacements, loadMapping, etc.). Replace the `generateGutachten` function at the bottom with:

```typescript
import { extractSlots, fillSlots, applySlots, type GutachtenSlot } from './gutachtenSlotFiller';

// --- Shared: load and prepare template ZIP with FELD_* replaced ---

function loadAndPrepareTemplate(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs
): { zip: PizZip; templateType: TemplateType; replacements: Record<string, string> } {
  const mapping = loadMapping();
  const rechtsform = getByPath(result, 'schuldner.rechtsform.wert');
  const templateType = determineTemplateType(rechtsform);
  const templateFilename = mapping.templates[templateType];

  if (!templateFilename) throw new Error(`Kein Template für Typ: ${templateType}`);

  const templatePath = path.resolve(TEMPLATES_DIR, templateFilename);
  if (!templatePath.startsWith(TEMPLATES_DIR)) throw new Error(`Ungültiger Template-Pfad: ${templateFilename}`);
  if (!fs.existsSync(templatePath)) throw new Error(`Template nicht gefunden: ${templateFilename}`);

  const replacements = buildReplacements(result, userInputs);
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);

  // Apply FELD_* replacements to all XML parts
  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const xmlContent = file.asText();
    zip.file(partName, replaceFieldsInXml(xmlContent, replacements));
  }

  return { zip, templateType, replacements };
}

const XML_PARTS = [
  'word/document.xml', 'word/header1.xml', 'word/header2.xml',
  'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml',
];

// --- Prepare: extract slots and fill via Claude ---

export async function prepareGutachten(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs
): Promise<{ templateType: TemplateType; slots: GutachtenSlot[]; feldValues: Record<string, string> }> {
  const { zip, templateType, replacements } = loadAndPrepareTemplate(result, userInputs);

  // Extract slots from all XML parts (after FELD_* replacement)
  let allSlots: import('./gutachtenSlotFiller').SlotInfo[] = [];
  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const { slots } = extractSlots(file.asText());
    allSlots = allSlots.concat(slots);
  }

  // Fill slots via Claude
  const filledSlots = await fillSlots(allSlots, result);

  return { templateType, slots: filledSlots, feldValues: replacements };
}

// --- Generate: apply final slot values and return DOCX buffer ---

export function generateGutachtenFinal(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs,
  finalSlots: { id: string; value: string }[]
): Buffer {
  const { zip } = loadAndPrepareTemplate(result, userInputs);

  // First extract slots (to get the [[SLOT_NNN]] markers in the XML)
  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const { xml: slottedXml } = extractSlots(file.asText());
    // Then apply the user's final values
    const finalXml = applySlots(slottedXml, finalSlots);
    zip.file(partName, finalXml);
  }

  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
```

Also add `XML_PARTS` as a module-level constant, and remove the old `generateGutachten` function.

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/utils/gutachtenGenerator.ts
git commit -m "feat: split gutachten generation into prepare (slots) and generate (DOCX) steps"
```

---

### Task 4: Update the backend route with two endpoints

**Files:**
- Modify: `backend/src/routes/generateGutachten.ts`

- [ ] **Step 1: Replace the single endpoint with prepare + generate**

Rewrite the file:

```typescript
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import {
  prepareGutachten,
  generateGutachtenFinal,
  type GutachtenUserInputs,
} from '../utils/gutachtenGenerator';
import type { ExtractionResult } from '../types/extraction';

const router = Router();

function parseUserInputs(body: Record<string, unknown>): GutachtenUserInputs | null {
  const { verwalter_diktatzeichen, verwalter_geschlecht } = body;
  if (!verwalter_diktatzeichen || typeof verwalter_diktatzeichen !== 'string') return null;
  if (verwalter_geschlecht !== 'maennlich' && verwalter_geschlecht !== 'weiblich') return null;

  return {
    verwalter_diktatzeichen: String(verwalter_diktatzeichen),
    verwalter_geschlecht: verwalter_geschlecht as 'maennlich' | 'weiblich',
    anderkonto_iban: body.anderkonto_iban ? String(body.anderkonto_iban) : undefined,
    anderkonto_bank: body.anderkonto_bank ? String(body.anderkonto_bank) : undefined,
    geschaeftsfuehrer: body.geschaeftsfuehrer ? String(body.geschaeftsfuehrer) : undefined,
    last_gavv: body.last_gavv ? String(body.last_gavv) : undefined,
  };
}

function loadExtraction(extractionId: number, userId: number): ExtractionResult | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT result_json FROM extractions WHERE id = ? AND user_id = ? AND status = 'completed'`
  ).get(extractionId, userId) as { result_json: string } | undefined;
  if (!row?.result_json) return null;
  return readResultJson<ExtractionResult>(row.result_json)!;
}

// POST /:extractionId/prepare — extract slots, fill via Claude, return JSON
router.post('/:extractionId/prepare', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const extractionId = parseInt(String(req.params['extractionId'] ?? ''), 10);
    if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige Extraktions-ID' }); return; }

    const userInputs = parseUserInputs(req.body);
    if (!userInputs) { res.status(400).json({ error: 'verwalter_diktatzeichen und verwalter_geschlecht sind erforderlich' }); return; }

    const result = loadExtraction(extractionId, req.user!.userId);
    if (!result) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    const prepared = await prepareGutachten(result, userInputs);
    res.json(prepared);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Vorbereitung fehlgeschlagen';
    res.status(500).json({ error: msg });
  }
});

// POST /:extractionId/generate — apply slot values, return DOCX
router.post('/:extractionId/generate', authMiddleware, (req: Request, res: Response): void => {
  try {
    const extractionId = parseInt(String(req.params['extractionId'] ?? ''), 10);
    if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige Extraktions-ID' }); return; }

    const { userInputs: rawInputs, slots } = req.body as { userInputs?: Record<string, unknown>; slots?: { id: string; value: string }[] };

    const userInputs = rawInputs ? parseUserInputs(rawInputs) : null;
    if (!userInputs) { res.status(400).json({ error: 'userInputs mit verwalter_diktatzeichen und verwalter_geschlecht erforderlich' }); return; }
    if (!Array.isArray(slots)) { res.status(400).json({ error: 'slots Array erforderlich' }); return; }

    const result = loadExtraction(extractionId, req.user!.userId);
    if (!result) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    const buffer = generateGutachtenFinal(result, userInputs, slots);
    const safeName = `Gutachten_${extractionId}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gutachten-Generierung fehlgeschlagen';
    res.status(500).json({ error: msg });
  }
});

export default router;
```

- [ ] **Step 2: Verify backend compiles and tests pass**

Run: `cd backend && npx tsc --noEmit && npm run test`
Expected: Clean compile, 61 tests pass

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/generateGutachten.ts
git commit -m "feat: split gutachten route into prepare (JSON) and generate (DOCX) endpoints"
```

---

### Task 5: Rewrite `GutachtenDialog.tsx` as multi-step wizard

**Files:**
- Modify: `frontend/src/components/extraction/GutachtenDialog.tsx`

- [ ] **Step 1: Rewrite the dialog as a 3-step wizard**

The dialog needs these states:
- `step`: 1 (user inputs) → 2 (slot review) → 3 (generating/done)
- `slots`: `GutachtenSlot[]` from prepare response
- `editedSlots`: `Map<string, string>` for user edits
- `preparing`: boolean for the prepare API call
- `generating`: boolean for the generate API call

**Step 1 (Verwalter-Daten):** Same as current — input fields for diktatzeichen, geschlecht, anderkonto, etc. "Weiter" button calls `POST /generate-gutachten/:id/prepare` and moves to step 2.

**Step 2 (Slot-Review):** Shows all slots as a scrollable list. Each slot shows:
- Context (truncated, monospace, with `[[SLOT_NNN]]` highlighted)
- Editable input field with current value
- Status badge: green (filled), yellow (todo), gray (editorial)

"Generieren" button calls `POST /generate-gutachten/:id/generate` with the final slot values.

**Step 3 (Download):** Auto-triggers DOCX download, shows success message.

The full component code is ~250 lines. Key patterns from the existing dialog to preserve:
- `apiClient.post()` for API calls (cookie-based auth)
- `responseType: 'blob'` for the generate endpoint
- Blob download pattern with `URL.createObjectURL`
- Error handling for blob responses
- Same CSS classes: `inputClass`, `SummaryRow`, backdrop overlay

Key new element — the slot editor in step 2:

```tsx
{/* Slot list */}
<div className="max-h-[50vh] overflow-y-auto space-y-2">
  {slots.map((slot) => (
    <div
      key={slot.id}
      className={`p-2 border rounded-sm ${
        slot.status === 'filled' ? 'border-emerald-400/30 bg-emerald-400/5' :
        slot.status === 'editorial' ? 'border-border bg-bg' :
        'border-amber-400/30 bg-amber-400/5'
      }`}
    >
      <div className="text-[9px] text-text-dim font-mono mb-1 truncate">
        {slot.context}
      </div>
      {slot.status === 'editorial' ? (
        <div className="text-[10px] text-text-muted italic">{slot.value}</div>
      ) : (
        <input
          type="text"
          value={editedSlots.get(slot.id) ?? slot.value}
          onChange={e => setEditedSlots(prev => new Map(prev).set(slot.id, e.target.value))}
          className={inputClass}
        />
      )}
    </div>
  ))}
</div>
```

- [ ] **Step 2: Verify frontend compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors (or only pre-existing issues)

- [ ] **Step 3: Build frontend**

Run: `cd frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/extraction/GutachtenDialog.tsx
git commit -m "feat: rewrite GutachtenDialog as multi-step wizard with slot preview"
```

---

### Task 6: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Backend build**

Run: `cd backend && npm run build`
Expected: Clean compile

- [ ] **Step 2: Backend tests**

Run: `cd backend && npm run test`
Expected: 61 tests pass

- [ ] **Step 3: Frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

If a running instance is available:
1. Open dashboard with a completed extraction
2. Go to Gutachten tab → click "Gutachten generieren"
3. Fill Verwalter-Daten → click "Vorbereiten"
4. Review slot preview (check that slots show context + proposed values)
5. Edit a few slots → click "Generieren & Herunterladen"
6. Open downloaded DOCX → verify FELD_* and slot values are filled
