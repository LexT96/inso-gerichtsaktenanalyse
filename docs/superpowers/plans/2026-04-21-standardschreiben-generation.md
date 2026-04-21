# Standardschreiben Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate any of the 10 standard letters (Bankenauskunft, Finanzamt, Versicherung, etc.) from the AnschreibenTab as a DOCX with all `FELD_*` placeholders filled from the extraction, plus admin upload/download/rollback for the DOCX templates.

**Architecture:** Reuse the Gutachten generation pattern — `processDocxParagraphs` flattens Word run-splitting, XML text replacement fills `FELD_*` tokens, a single `platzhalter-mapping.json` declares where each field comes from (path / computed / kanzlei / verwalter / input). Strafakte requires 3 additional user-input fields collected via a frontend modal before generation.

**Tech Stack:** Express 4 + TypeScript (backend), PizZip for DOCX XML manipulation, React 18 + Tailwind (frontend), vitest + supertest (tests).

---

## File Structure

**Templates & config (already in repo):**
- `standardschreiben/templates/*.docx` — 10 DOCX templates (exists)
- `standardschreiben/checklisten.json` — modify: add `templateDocx` per letter type
- `standardschreiben/platzhalter-mapping.json` — **create**: 32-field catalog

**Backend:**
- `backend/src/utils/letterGenerator.ts` — **create**: `generateLetterFromTemplate(template, result, verwalter, extras) → Buffer`. Reuses `processDocxParagraphs` from gutachtenGenerator.
- `backend/src/utils/__tests__/letterGenerator.test.ts` — **create**
- `backend/src/routes/generateLetter.ts` — **rewrite**: load templateDocx from checklisten, call generator, stream DOCX back
- `backend/src/routes/letterTemplates.ts` — **create**: list / download / upload / rollback per letter type
- `backend/src/index.ts` — **modify**: mount `letterTemplates` router
- `backend/src/utils/docxGenerator.ts` — **delete** (replaced by letterGenerator.ts)

**Frontend:**
- `frontend/src/components/extraction/tabs/AnschreibenTab.tsx` — **modify**: "DOCX erzeugen" button per `bereit`-letter, Strafakte modal
- `frontend/src/components/extraction/StrafakteInputsModal.tsx` — **create**: 3-field modal
- `frontend/src/pages/AdminPage.tsx` — **modify**: add "Standardschreiben-Vorlagen" section (mirrors existing Gutachten section)
- `frontend/src/components/admin/LetterTemplatesSection.tsx` — **create**: list/download/upload/rollback UI

---

## Task 1: Restore `platzhalter-mapping.json`

**Files:**
- Create: `standardschreiben/platzhalter-mapping.json`

- [ ] **Step 1: Create the mapping file**

Create `standardschreiben/platzhalter-mapping.json`:

```json
{
  "_version": "2.0",
  "_beschreibung": "FELD_* → Quelle. Quellentypen: path=ExtractionResult, computed=Helper-Funktion, verwalter=verwalter_profiles, static=Konstante, input=User-Eingabe",
  "felder": {
    "FELD_Akte_Aktenzeichen": { "path": "verfahrensdaten.aktenzeichen.wert" },
    "FELD_Akte_Gericht": { "path": "verfahrensdaten.gericht.wert" },
    "FELD_Akte_LastGAVV": { "path": "verfahrensdaten.beschlussdatum.wert" },
    "FELD_Akte_LastGAW": { "path": "verfahrensdaten.beschlussdatum.wert" },
    "FELD_Akte_EroeffDat": { "computed": "eroeffnungsdatum_oder_beschluss" },
    "FELD_Akte_Bezeichnung": { "computed": "akte_bezeichnung" },
    "FELD_Akte_VerfahrenArt": { "computed": "verfahren_art" },
    "FELD_Gericht_Ort": { "computed": "gericht_ort" },

    "FELD_Schuldner_Name": { "path": "schuldner.name.wert" },
    "FELD_Schuldner_Vorname": { "path": "schuldner.vorname.wert" },
    "FELD_Schuldner_Vollname": { "computed": "schuldner_vollname" },
    "FELD_Schuldner_Adr": { "path": "schuldner.aktuelle_adresse.wert" },
    "FELD_Schuldner_Adresse": { "path": "schuldner.aktuelle_adresse.wert" },
    "FELD_Schuldner_Geburtsdatum": { "path": "schuldner.geburtsdatum.wert" },
    "FELD_Schuldner_Firma": { "path": "schuldner.firma.wert" },
    "FELD_Schuldner_Betriebsstaette": { "path": "schuldner.betriebsstaette_adresse.wert" },
    "FELD_Schuldner_HRB": { "path": "schuldner.handelsregisternummer.wert" },

    "FELD_Schuldner_Artikel": { "computed": "schuldner_der_die" },
    "FELD_Schuldner_der_die": { "computed": "schuldner_der_die" },
    "FELD_Schuldner_Der_Die_Groß": { "computed": "schuldner_Der_Die" },
    "FELD_Schuldner_den_die": { "computed": "schuldner_den_die" },
    "FELD_Schuldner_dem_der": { "computed": "schuldner_dem_der" },
    "FELD_Schuldner_Schuldnerin": { "computed": "schuldner_nominativ_substantiv" },
    "FELD_Schuldners_Schuldnerin": { "computed": "schuldner_genitiv_substantiv" },
    "FELD_Schuldner_Halters_Halterin": { "computed": "schuldner_halters_halterin" },

    "FELD_Verwalter_Name": { "verwalter": "name" },
    "FELD_Verwalter_Unterzeichner": { "verwalter": "name" },
    "FELD_Verwalter_Art": { "verwalter": "art" },
    "FELD_Verwalter_Diktatzeichen": { "verwalter": "diktatzeichen" },
    "FELD_Verwalter_der_die": { "computed": "verwalter_der_die" },
    "FELD_Verwalter_Der_Die_Groß": { "computed": "verwalter_Der_Die" },
    "FELD_Verwalter_zum_zur": { "computed": "verwalter_zum_zur" },

    "FELD_Bet_AnredeHoeflichOV": { "static": "Sehr geehrte Damen und Herren," },
    "FELD_Bet_GrussBriefende": { "static": "Mit freundlichen Grüßen" },
    "FELD_ANSCHREIBEN_DAT_2": { "computed": "antwort_frist" },

    "FELD_Strafverfahren_Person": { "input": "strafverfahren_person" },
    "FELD_Strafverfahren_Tatvorwurf": { "input": "strafverfahren_tatvorwurf" },
    "FELD_Strafverfahren_Gegenstand": { "input": "strafverfahren_gegenstand" }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add standardschreiben/platzhalter-mapping.json
git commit -m "feat(standardschreiben): restore platzhalter-mapping.json with 32-field catalog"
```

---

## Task 2: Add `templateDocx` + `uiInputs` to `checklisten.json`

**Files:**
- Modify: `standardschreiben/checklisten.json`
- Modify: `standardschreiben/checklisten.schema.json`

- [ ] **Step 1: Add `templateDocx` field to every entry**

For each of the 10 entries in `checklisten.json`, add a `templateDocx` key pointing to the corresponding DOCX filename. Strafakte also gets `uiInputs` listing the 3 required user inputs.

Add after each entry's `empfaengerDefault`:

- Bankenauskunft: `"templateDocx": "templates/Bankenanfrage.docx"`
- Bausparkassen-Anfrage: `"templateDocx": "templates/Anfrage_zu_bestehendem_Vertragsverhältnis_Bausparkasse_.docx"`
- Steuerberater-Kontakt: `"templateDocx": "templates/Muster_Kontaktaufnahme_Steuerberater.docx"`
- Strafakte-Akteneinsicht: `"templateDocx": "templates/Einsichtnahmegesuch_Strafakte_Anfrage_zur_Akteneinsicht_.docx"`, plus:

```json
"uiInputs": [
  { "key": "strafverfahren_person", "label": "Angeklagte Person", "placeholder": "z.B. den Geschäftsführer Max Mustermann" },
  { "key": "strafverfahren_tatvorwurf", "label": "Tatvorwurf", "placeholder": "z.B. des Betrugs / der Untreue" },
  { "key": "strafverfahren_gegenstand", "label": "Erwartete Informationen", "placeholder": "z.B. Zahlungsströme, Pflichtverletzungen" }
]
```

- KFZ-Halteranfrage Zulassungsstelle: `"templateDocx": "templates/Halteranfrage_Zulassungsstelle.docx"`
- Gewerbeauskunft: `"templateDocx": "templates/Gewerbeanfrage.docx"`
- Finanzamt-Anfrage: `"templateDocx": "templates/Anfrage_ans_Finanzamt.docx"`
- KFZ-Halteranfrage KBA: `"templateDocx": "templates/Halteranfrage_Kraftfahrt_Bundesamt.docx"`
- Versicherungsanfrage: `"templateDocx": "templates/Muster_Versicherungsanfrage.docx"`
- Gerichtsvollzieher-Anfrage: `"templateDocx": "templates/Gerichtsvollzieheranfrage.docx"`

- [ ] **Step 2: Update `checklisten.schema.json`**

Add to the schema's `properties` inside the `anschreiben` item schema:

```json
"templateDocx": { "type": "string" },
"uiInputs": {
  "type": "array",
  "items": {
    "type": "object",
    "required": ["key", "label"],
    "properties": {
      "key": { "type": "string" },
      "label": { "type": "string" },
      "placeholder": { "type": "string" }
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add standardschreiben/checklisten.json standardschreiben/checklisten.schema.json
git commit -m "feat(standardschreiben): wire templateDocx + uiInputs into checklisten"
```

---

## Task 3: Shared gender helpers (test first)

We already have gender helpers inside `gutachtenGenerator.ts`, but the letter generator needs a subset plus two new variants (`dem_der`, `Halters_Halterin`). Extract a small helper module to keep letter code focused and avoid a 1500-line import.

**Files:**
- Create: `backend/src/utils/genderHelpers.ts`
- Test: `backend/src/utils/__tests__/genderHelpers.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/src/utils/__tests__/genderHelpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { schuldnerGender, verwalterGender } from '../genderHelpers';

describe('schuldnerGender', () => {
  it('returns masculine articles for männlich', () => {
    expect(schuldnerGender('maennlich', 'der_die')).toBe('der');
    expect(schuldnerGender('maennlich', 'Der_Die')).toBe('Der');
    expect(schuldnerGender('maennlich', 'den_die')).toBe('den');
    expect(schuldnerGender('maennlich', 'dem_der')).toBe('dem');
    expect(schuldnerGender('maennlich', 'nominativ_substantiv')).toBe('Schuldner');
    expect(schuldnerGender('maennlich', 'genitiv_substantiv')).toBe('Schuldners');
    expect(schuldnerGender('maennlich', 'halters_halterin')).toBe('des Halters');
  });

  it('returns feminine articles for weiblich', () => {
    expect(schuldnerGender('weiblich', 'der_die')).toBe('die');
    expect(schuldnerGender('weiblich', 'Der_Die')).toBe('Die');
    expect(schuldnerGender('weiblich', 'den_die')).toBe('die');
    expect(schuldnerGender('weiblich', 'dem_der')).toBe('der');
    expect(schuldnerGender('weiblich', 'nominativ_substantiv')).toBe('Schuldnerin');
    expect(schuldnerGender('weiblich', 'genitiv_substantiv')).toBe('Schuldnerin');
    expect(schuldnerGender('weiblich', 'halters_halterin')).toBe('der Halterin');
  });

  it('defaults to masculine for null/unknown', () => {
    expect(schuldnerGender(null, 'der_die')).toBe('der');
    expect(schuldnerGender('unknown', 'der_die')).toBe('der');
  });
});

describe('verwalterGender', () => {
  it('returns correct forms for maennlich', () => {
    expect(verwalterGender('maennlich', 'der_die')).toBe('der');
    expect(verwalterGender('maennlich', 'Der_Die')).toBe('Der');
    expect(verwalterGender('maennlich', 'zum_zur')).toBe('zum');
  });

  it('returns correct forms for weiblich', () => {
    expect(verwalterGender('weiblich', 'der_die')).toBe('die');
    expect(verwalterGender('weiblich', 'Der_Die')).toBe('Die');
    expect(verwalterGender('weiblich', 'zum_zur')).toBe('zur');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd backend && npx vitest run src/utils/__tests__/genderHelpers.test.ts
```

Expected: `Cannot find module '../genderHelpers'`

- [ ] **Step 3: Implement**

`backend/src/utils/genderHelpers.ts`:

```typescript
export type GenderInput = string | null | undefined;

function isWeiblich(g: GenderInput): boolean {
  if (!g) return false;
  const s = g.toLowerCase();
  return s === 'weiblich' || s === 'w' || s === 'female' || s === 'f';
}

export type SchuldnerVariant =
  | 'der_die'
  | 'Der_Die'
  | 'den_die'
  | 'dem_der'
  | 'nominativ_substantiv'
  | 'genitiv_substantiv'
  | 'halters_halterin';

export function schuldnerGender(g: GenderInput, variant: SchuldnerVariant): string {
  const w = isWeiblich(g);
  switch (variant) {
    case 'der_die': return w ? 'die' : 'der';
    case 'Der_Die': return w ? 'Die' : 'Der';
    case 'den_die': return w ? 'die' : 'den';
    case 'dem_der': return w ? 'der' : 'dem';
    case 'nominativ_substantiv': return w ? 'Schuldnerin' : 'Schuldner';
    case 'genitiv_substantiv': return w ? 'Schuldnerin' : 'Schuldners';
    case 'halters_halterin': return w ? 'der Halterin' : 'des Halters';
  }
}

export type VerwalterVariant = 'der_die' | 'Der_Die' | 'zum_zur';

export function verwalterGender(g: GenderInput, variant: VerwalterVariant): string {
  const w = isWeiblich(g);
  switch (variant) {
    case 'der_die': return w ? 'die' : 'der';
    case 'Der_Die': return w ? 'Die' : 'Der';
    case 'zum_zur': return w ? 'zur' : 'zum';
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
cd backend && npx vitest run src/utils/__tests__/genderHelpers.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/genderHelpers.ts backend/src/utils/__tests__/genderHelpers.test.ts
git commit -m "feat(letters): add gender helpers with dem_der + halters_halterin"
```

---

## Task 4: `letterGenerator.ts` — core mapping + XML replacement (TDD)

**Files:**
- Create: `backend/src/utils/letterGenerator.ts`
- Test: `backend/src/utils/__tests__/letterGenerator.test.ts`
- Create: `backend/src/utils/__tests__/fixtures/test-letter.docx`

- [ ] **Step 1: Generate a tiny fixture template**

Script:

```bash
cd backend
mkdir -p src/utils/__tests__/fixtures
cat > /tmp/make-fixture.mjs <<'EOF'
import { Document, Packer, Paragraph, TextRun } from 'docx';
const doc = new Document({
  sections: [{
    children: [
      new Paragraph({ children: [new TextRun('FELD_Bet_AnredeHoeflichOV')] }),
      new Paragraph({ children: [new TextRun('Az FELD_Akte_Aktenzeichen vom FELD_Akte_LastGAVV. FELD_Schuldner_Artikel FELD_Schuldner_Schuldnerin wohnt.')] }),
      new Paragraph({ children: [new TextRun('FELD_Verwalter_Diktatzeichen FELD_Verwalter_Name als FELD_Verwalter_Art')] }),
    ],
  }],
});
const buf = await Packer.toBuffer(doc);
const fs = await import('node:fs');
fs.writeFileSync('src/utils/__tests__/fixtures/test-letter.docx', buf);
EOF
npm install --no-save docx
node /tmp/make-fixture.mjs
```

- [ ] **Step 2: Write the failing test**

`backend/src/utils/__tests__/letterGenerator.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import { generateLetterFromTemplate } from '../letterGenerator';
import type { ExtractionResult } from '../../types/extraction';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function readDocxText(buf: Buffer): string {
  const zip = new PizZip(buf);
  const xml = zip.file('word/document.xml')!.asText();
  const texts: string[] = [];
  for (const m of xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) texts.push(m[1]);
  return texts.join('');
}

describe('generateLetterFromTemplate', () => {
  const fixture = path.join(FIXTURE_DIR, 'test-letter.docx');
  let template: Buffer;
  beforeAll(() => { template = fs.readFileSync(fixture); });

  const baseResult = {
    verfahrensdaten: {
      aktenzeichen: { wert: '12 IN 123/24', quelle: 'Seite 1' },
      gericht: { wert: 'Amtsgericht München', quelle: 'Seite 1' },
      beschlussdatum: { wert: '15.03.2024', quelle: 'Seite 1' },
    },
    schuldner: {
      name: { wert: 'Mustermann', quelle: 'Seite 1' },
      vorname: { wert: 'Max', quelle: 'Seite 1' },
      geschlecht: { wert: 'maennlich', quelle: 'Seite 1' },
    },
  } as unknown as ExtractionResult;

  const baseVerwalter = {
    name: 'Prof. Dr. Schmidt',
    art: 'Insolvenzverwalter',
    diktatzeichen: 'TBS/ab',
    geschlecht: 'maennlich' as const,
  };

  it('replaces scalar path placeholders', () => {
    const out = generateLetterFromTemplate(template, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('12 IN 123/24');
    expect(text).toContain('15.03.2024');
    expect(text).not.toContain('FELD_Akte_Aktenzeichen');
    expect(text).not.toContain('FELD_Akte_LastGAVV');
  });

  it('replaces gender-computed placeholders for male', () => {
    const out = generateLetterFromTemplate(template, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('der Schuldner wohnt');
  });

  it('replaces gender-computed placeholders for female', () => {
    const resultFemale = {
      ...baseResult,
      schuldner: { ...baseResult.schuldner, geschlecht: { wert: 'weiblich', quelle: 'x' } },
    } as ExtractionResult;
    const out = generateLetterFromTemplate(template, resultFemale, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('die Schuldnerin wohnt');
  });

  it('replaces verwalter fields', () => {
    const out = generateLetterFromTemplate(template, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('TBS/ab Prof. Dr. Schmidt als Insolvenzverwalter');
  });

  it('leaves missing placeholders empty (no FELD_ leakage)', () => {
    const thin = { verfahrensdaten: {}, schuldner: {} } as unknown as ExtractionResult;
    const out = generateLetterFromTemplate(template, thin, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).not.toMatch(/FELD_/);
  });

  it('handles Word run-splitting (placeholder split across two runs)', () => {
    const zip = new PizZip(template);
    let xml = zip.file('word/document.xml')!.asText();
    xml = xml.replace(
      'Az FELD_Akte_Aktenzeichen vom FELD_Akte_LastGAVV. FELD_Schuldner_Artikel FELD_Schuldner_Schuldnerin wohnt.',
      'Az FELD_</w:t></w:r><w:r><w:t xml:space="preserve">Akte_Aktenzeichen vom FELD_Akte_LastGAVV. FELD_Schuldner_Artikel FELD_Schuldner_Schuldnerin wohnt.',
    );
    zip.file('word/document.xml', xml);
    const split = zip.generate({ type: 'nodebuffer' }) as Buffer;
    const out = generateLetterFromTemplate(split, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('12 IN 123/24');
    expect(text).not.toContain('FELD_Akte_Aktenzeichen');
  });

  it('replaces user-input placeholders (Strafakte)', () => {
    const zip = new PizZip(template);
    let xml = zip.file('word/document.xml')!.asText();
    xml = xml.replace('als FELD_Verwalter_Art', 'wegen FELD_Strafverfahren_Tatvorwurf');
    zip.file('word/document.xml', xml);
    const custom = zip.generate({ type: 'nodebuffer' }) as Buffer;
    const out = generateLetterFromTemplate(custom, baseResult, baseVerwalter, {
      strafverfahren_tatvorwurf: 'des Betrugs',
    });
    const text = readDocxText(out);
    expect(text).toContain('wegen des Betrugs');
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
cd backend && npx vitest run src/utils/__tests__/letterGenerator.test.ts
```

Expected: `Cannot find module '../letterGenerator'`

- [ ] **Step 4: Implement `letterGenerator.ts`**

`backend/src/utils/letterGenerator.ts`:

```typescript
import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import { processDocxParagraphs } from './gutachtenGenerator';
import { schuldnerGender, verwalterGender, type GenderInput } from './genderHelpers';
import type { ExtractionResult } from '../types/extraction';

function findStandardschreibenDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben');
}

const MAPPING_PATH = path.join(findStandardschreibenDir(), 'platzhalter-mapping.json');

interface FieldMapping {
  path?: string;
  computed?: string;
  verwalter?: string;
  static?: string;
  input?: string;
}

interface MappingFile {
  felder: Record<string, FieldMapping>;
}

let _mappingCache: MappingFile | null = null;
function loadMapping(): MappingFile {
  if (!_mappingCache) {
    _mappingCache = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8')) as MappingFile;
  }
  return _mappingCache;
}
export function invalidateLetterMappingCache(): void { _mappingCache = null; }

export interface LetterVerwalterProfile {
  name: string;
  art: string;
  diktatzeichen: string;
  geschlecht: 'maennlich' | 'weiblich';
}

export type LetterExtras = Record<string, string>;

function getByPath(obj: unknown, dotPath: string): string {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const p of parts) {
    if (current && typeof current === 'object' && p in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[p];
    } else {
      return '';
    }
  }
  return current == null ? '' : String(current);
}

function computeField(
  name: string,
  result: ExtractionResult,
  verwalter: LetterVerwalterProfile,
): string {
  const schuldnerGeschlecht = getByPath(result, 'schuldner.geschlecht.wert') as GenderInput;

  switch (name) {
    case 'schuldner_der_die': return schuldnerGender(schuldnerGeschlecht, 'der_die');
    case 'schuldner_Der_Die': return schuldnerGender(schuldnerGeschlecht, 'Der_Die');
    case 'schuldner_den_die': return schuldnerGender(schuldnerGeschlecht, 'den_die');
    case 'schuldner_dem_der': return schuldnerGender(schuldnerGeschlecht, 'dem_der');
    case 'schuldner_nominativ_substantiv': return schuldnerGender(schuldnerGeschlecht, 'nominativ_substantiv');
    case 'schuldner_genitiv_substantiv': return schuldnerGender(schuldnerGeschlecht, 'genitiv_substantiv');
    case 'schuldner_halters_halterin': return schuldnerGender(schuldnerGeschlecht, 'halters_halterin');

    case 'verwalter_der_die': return verwalterGender(verwalter.geschlecht, 'der_die');
    case 'verwalter_Der_Die': return verwalterGender(verwalter.geschlecht, 'Der_Die');
    case 'verwalter_zum_zur': return verwalterGender(verwalter.geschlecht, 'zum_zur');

    case 'schuldner_vollname': {
      const firma = getByPath(result, 'schuldner.firma.wert');
      if (firma) return firma;
      const vorname = getByPath(result, 'schuldner.vorname.wert');
      const name = getByPath(result, 'schuldner.name.wert');
      return [vorname, name].filter(Boolean).join(' ');
    }

    case 'gericht_ort': {
      const g = getByPath(result, 'verfahrensdaten.gericht.wert');
      return g.replace(/^Amtsgericht\s+/i, '').split(/\s-/)[0].trim();
    }

    case 'verfahren_art': {
      const va = getByPath(result, 'verfahrensdaten.verfahrensart.wert').toLowerCase();
      if (va.includes('antrag')) return 'Insolvenzantragsverfahren';
      return 'Insolvenzverfahren';
    }

    case 'akte_bezeichnung': {
      const az = getByPath(result, 'verfahrensdaten.aktenzeichen.wert');
      const va = computeField('verfahren_art', result, verwalter);
      return [az, va].filter(Boolean).join(', ');
    }

    case 'eroeffnungsdatum_oder_beschluss': {
      return getByPath(result, 'verfahrensdaten.eroeffnungsdatum.wert')
        || getByPath(result, 'verfahrensdaten.beschlussdatum.wert');
    }

    case 'antwort_frist': {
      // heute + 14 Werktage, Format: TT.MM.JJJJ
      const d = new Date();
      let added = 0;
      while (added < 14) {
        d.setDate(d.getDate() + 1);
        const day = d.getDay();
        if (day !== 0 && day !== 6) added++;
      }
      return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    default: return '';
  }
}

export function buildLetterReplacements(
  result: ExtractionResult,
  verwalter: LetterVerwalterProfile,
  extras: LetterExtras,
): Record<string, string> {
  const mapping = loadMapping();
  const replacements: Record<string, string> = {};

  for (const [feld, def] of Object.entries(mapping.felder)) {
    if (def.static !== undefined) {
      replacements[feld] = def.static;
    } else if (def.path) {
      replacements[feld] = getByPath(result, def.path);
    } else if (def.computed) {
      replacements[feld] = computeField(def.computed, result, verwalter);
    } else if (def.verwalter) {
      replacements[feld] = (verwalter as unknown as Record<string, string>)[def.verwalter] ?? '';
    } else if (def.input) {
      replacements[feld] = extras[def.input] ?? '';
    }
  }

  return replacements;
}

// Longest-first placeholder ordering prevents FELD_Schuldner_Name being replaced
// before FELD_Schuldner_NameVorname (hypothetical longer key) would match.
function replaceAllPlaceholders(text: string, replacements: Record<string, string>): string {
  const tokens = Object.keys(replacements).sort((a, b) => b.length - a.length);
  let out = text;
  for (const tok of tokens) {
    out = out.split(tok).join(replacements[tok] ?? '');
  }
  // Any remaining FELD_* (unmapped) → remove to avoid leakage
  out = out.replace(/FELD_[A-Za-zÄÖÜäöüß0-9_]+/g, '');
  return out;
}

export function generateLetterFromTemplate(
  templateBuffer: Buffer,
  result: ExtractionResult,
  verwalter: LetterVerwalterProfile,
  extras: LetterExtras,
): Buffer {
  const replacements = buildLetterReplacements(result, verwalter, extras);
  const zip = new PizZip(templateBuffer);
  const docXml = zip.file('word/document.xml');
  if (!docXml) throw new Error('word/document.xml nicht gefunden — keine gültige DOCX-Datei');
  let xml = docXml.asText();

  xml = processDocxParagraphs(
    xml,
    (fullText) => fullText.includes('FELD_'),
    (fullText) => replaceAllPlaceholders(fullText, replacements),
  );

  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd backend && npx vitest run src/utils/__tests__/letterGenerator.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/letterGenerator.ts backend/src/utils/__tests__/letterGenerator.test.ts backend/src/utils/__tests__/fixtures/test-letter.docx
git commit -m "feat(letters): letterGenerator with XML replacement, gender + input fields"
```

---

## Task 5: Rewrite `generateLetter.ts` route

**Files:**
- Rewrite: `backend/src/routes/generateLetter.ts`
- Delete: `backend/src/utils/docxGenerator.ts`

- [ ] **Step 1: Rewrite the route**

Replace `backend/src/routes/generateLetter.ts` contents with:

```typescript
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import { generateLetterFromTemplate, type LetterVerwalterProfile, type LetterExtras } from '../utils/letterGenerator';
import type { ExtractionResult } from '../types/extraction';
import { logger } from '../utils/logger';

const router = Router();

function findStandardschreibenDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben');
}

interface LetterChecklistEntry {
  typ: string;
  typAliases?: string[];
  templateDocx?: string;
  uiInputs?: Array<{ key: string; label: string; placeholder?: string }>;
}

interface ChecklistFile {
  anschreiben: LetterChecklistEntry[];
}

function loadChecklisten(): ChecklistFile {
  const p = path.join(findStandardschreibenDir(), 'checklisten.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ChecklistFile;
}

function findChecklistEntry(typ: string): LetterChecklistEntry | undefined {
  const { anschreiben } = loadChecklisten();
  return anschreiben.find(
    (c) => c.typ === typ
      || c.typ.toLowerCase() === typ.toLowerCase()
      || c.typAliases?.includes(typ),
  );
}

function loadVerwalterProfile(
  db: ReturnType<typeof getDb>,
  verwalterId: number | null,
): LetterVerwalterProfile | null {
  if (!verwalterId) return null;
  const row = db.prepare(
    `SELECT name, art, diktatzeichen, geschlecht FROM verwalter_profiles WHERE id = ?`,
  ).get(verwalterId) as
    | { name: string; art: string; diktatzeichen: string; geschlecht: string }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    art: row.art ?? 'Insolvenzverwalter',
    diktatzeichen: row.diktatzeichen ?? '',
    geschlecht: row.geschlecht === 'weiblich' ? 'weiblich' : 'maennlich',
  };
}

// POST /:extractionId/:typ  body: { verwalterId?: number, extras?: LetterExtras }
router.post('/:extractionId/:typ', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const extractionId = parseInt(String(req.params['extractionId'] ?? ''), 10);
  const typ = decodeURIComponent(String(req.params['typ'] ?? ''));

  if (isNaN(extractionId) || !typ) {
    res.status(400).json({ error: 'Ungültige Parameter' });
    return;
  }

  const row = db.prepare(
    `SELECT result_json, verwalter_id FROM extractions
     WHERE id = ? AND user_id = ? AND status = 'completed'`,
  ).get(extractionId, userId) as
    | { result_json: string; verwalter_id: number | null }
    | undefined;

  if (!row?.result_json) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  const result = readResultJson<ExtractionResult>(row.result_json);
  if (!result) {
    res.status(500).json({ error: 'Ergebnis konnte nicht gelesen werden' });
    return;
  }

  const letter = result.standardanschreiben?.find(
    (l) => l.typ === typ || l.typ?.toLowerCase() === typ.toLowerCase(),
  );
  if (!letter) {
    res.status(404).json({ error: `Anschreiben-Typ nicht gefunden: ${typ}` });
    return;
  }
  if (letter.status !== 'bereit') {
    res.status(422).json({ error: `Anschreiben nicht bereit (Status: ${letter.status})` });
    return;
  }

  const entry = findChecklistEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Kein Template für Typ: ${typ}` });
    return;
  }

  const verwalterIdBody = typeof req.body?.verwalterId === 'number' ? req.body.verwalterId : null;
  const verwalterId = verwalterIdBody ?? row.verwalter_id;
  const verwalter = loadVerwalterProfile(db, verwalterId);
  if (!verwalter) {
    res.status(422).json({ error: 'Verwalter-Profil nicht gefunden. Bitte Verwalter wählen.' });
    return;
  }

  // Validate uiInputs for letters that require them (e.g. Strafakte)
  const extras: LetterExtras = (req.body?.extras && typeof req.body.extras === 'object')
    ? req.body.extras
    : {};
  const missingInputs = (entry.uiInputs ?? []).filter(
    (i) => !extras[i.key] || !String(extras[i.key]).trim(),
  );
  if (missingInputs.length > 0) {
    res.status(422).json({
      error: 'Pflicht-Eingaben fehlen',
      missing: missingInputs.map((i) => i.key),
    });
    return;
  }

  const templatePath = path.join(findStandardschreibenDir(), entry.templateDocx);
  if (!fs.existsSync(templatePath)) {
    res.status(404).json({ error: `Template-Datei fehlt: ${entry.templateDocx}` });
    return;
  }

  try {
    const templateBuffer = fs.readFileSync(templatePath);
    const buffer = generateLetterFromTemplate(templateBuffer, result, verwalter, extras);
    const safeName = `${typ.replace(/[^a-zA-Z0-9_-]/g, '_')}_${extractionId}.docx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generierung fehlgeschlagen';
    logger.error('Letter generation failed', { extractionId, typ, error: msg });
    res.status(500).json({ error: msg });
  }
});

export default router;
```

- [ ] **Step 2: Delete the old generator**

```bash
git rm backend/src/utils/docxGenerator.ts
```

- [ ] **Step 3: Start backend + smoke-test**

```bash
cd backend && npm run dev
```

In another shell (replace credentials as per your `.env`):

```bash
TOKEN=$(curl -s http://localhost:3004/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"'"$DEFAULT_ADMIN_PASSWORD"'"}' | jq -r .token)
ID=$(curl -s http://localhost:3004/api/history -H "Authorization: Bearer $TOKEN" | jq '.[0].id')
curl -v -X POST "http://localhost:3004/api/generate-letter/$ID/Bankenauskunft" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' -o /tmp/brief.docx
file /tmp/brief.docx
```

Expected: `/tmp/brief.docx: Microsoft Word 2007+`. Kill the server when done.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/generateLetter.ts
git commit -m "feat(letters): rewrite generateLetter route using letterGenerator + verwalter profile"
```

---

## Task 6: `letterTemplates.ts` admin route (upload/download/rollback)

**Files:**
- Create: `backend/src/routes/letterTemplates.ts`
- Modify: `backend/src/index.ts` (mount router)

- [ ] **Step 1: Create the route**

`backend/src/routes/letterTemplates.ts`:

```typescript
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import PizZip from 'pizzip';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../utils/logger';
import { invalidateLetterMappingCache } from '../utils/letterGenerator';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('template');

function findStandardschreibenDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben');
}

interface LetterChecklistEntry {
  typ: string;
  templateDocx?: string;
}
interface ChecklistFile { anschreiben: LetterChecklistEntry[]; }

function loadChecklisten(): ChecklistFile {
  return JSON.parse(
    fs.readFileSync(path.join(findStandardschreibenDir(), 'checklisten.json'), 'utf-8'),
  ) as ChecklistFile;
}

function findEntry(typ: string): LetterChecklistEntry | undefined {
  return loadChecklisten().anschreiben.find((e) => e.typ === typ);
}

// Extract full DOCX text (all <w:t> joined) — survives Word run-splitting
function extractDocxText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const docXml = zip.file('word/document.xml');
  if (!docXml) throw new Error('word/document.xml nicht gefunden — keine gültige DOCX-Datei.');
  const xml = docXml.asText();
  const texts: string[] = [];
  for (const m of xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) texts.push(m[1]);
  return texts.join('');
}

// Required placeholders per letter type: derived from current on-disk template
function getRequiredPlaceholders(typ: string): string[] {
  const entry = findEntry(typ);
  if (!entry?.templateDocx) return [];
  const p = path.join(findStandardschreibenDir(), entry.templateDocx);
  if (!fs.existsSync(p)) return [];
  const text = extractDocxText(fs.readFileSync(p));
  const tokens = new Set<string>();
  for (const m of text.matchAll(/FELD_[A-Za-zÄÖÜäöüß0-9]+(?:_[A-Za-zÄÖÜäöüß0-9]+)*/g)) {
    tokens.add(m[0]);
  }
  return [...tokens];
}

// GET / — list all letter templates
router.get('/', authMiddleware, (_req: Request, res: Response): void => {
  try {
    const dir = findStandardschreibenDir();
    const entries = loadChecklisten().anschreiben;
    const list = entries.map((e) => {
      const p = e.templateDocx ? path.join(dir, e.templateDocx) : null;
      let size: number | null = null;
      let lastModified: string | null = null;
      let hasBackup = false;
      if (p && fs.existsSync(p)) {
        const stat = fs.statSync(p);
        size = stat.size;
        lastModified = stat.mtime.toISOString();
        hasBackup = fs.existsSync(p + '.backup.docx');
      }
      return {
        typ: e.typ,
        filename: e.templateDocx ?? null,
        size,
        lastModified,
        hasBackup,
      };
    });
    res.json(list);
  } catch (err) {
    logger.error('Fehler beim Laden der Letter-Templates', { error: err });
    res.status(500).json({ error: 'Fehler beim Laden der Templates' });
  }
});

// GET /:typ/download — stream current DOCX
router.get('/:typ/download', authMiddleware, (req: Request, res: Response): void => {
  const typ = decodeURIComponent(req.params.typ ?? '');
  const entry = findEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Unbekannter Typ: ${typ}` });
    return;
  }
  const p = path.join(findStandardschreibenDir(), entry.templateDocx);
  if (!fs.existsSync(p)) {
    res.status(404).json({ error: 'Template-Datei nicht gefunden' });
    return;
  }
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(path.basename(entry.templateDocx))}"`,
  );
  res.send(fs.readFileSync(p));
});

// PUT /:typ — upload new template (multipart, field: template)
router.put('/:typ', authMiddleware, (req: Request, res: Response): void => {
  const typ = decodeURIComponent(req.params.typ ?? '');
  const entry = findEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Unbekannter Typ: ${typ}` });
    return;
  }
  upload(req, res, (uploadErr) => {
    if (uploadErr) {
      res.status(400).json({ error: uploadErr.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Keine Datei hochgeladen (Feldname: template)' });
      return;
    }
    let uploadedText: string;
    try { uploadedText = extractDocxText(req.file.buffer); }
    catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const required = getRequiredPlaceholders(typ);
    const missing = required.filter((p) => !uploadedText.includes(p));
    if (missing.length > 0) {
      res.status(422).json({ error: 'Pflicht-Platzhalter fehlen', missing });
      return;
    }
    try {
      const templatePath = path.join(findStandardschreibenDir(), entry.templateDocx!);
      const backupPath = templatePath + '.backup.docx';
      if (fs.existsSync(templatePath)) fs.copyFileSync(templatePath, backupPath);
      fs.writeFileSync(templatePath, req.file.buffer);
      invalidateLetterMappingCache();
      logger.info('Letter-Template aktualisiert', { typ, filename: entry.templateDocx });
      res.json({ ok: true, filename: entry.templateDocx });
    } catch (err) {
      logger.error('Fehler beim Speichern des Letter-Templates', { error: err, typ });
      res.status(500).json({ error: 'Fehler beim Speichern des Templates' });
    }
  });
});

// POST /:typ/rollback — restore .backup.docx
router.post('/:typ/rollback', authMiddleware, (req: Request, res: Response): void => {
  const typ = decodeURIComponent(req.params.typ ?? '');
  const entry = findEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Unbekannter Typ: ${typ}` });
    return;
  }
  const p = path.join(findStandardschreibenDir(), entry.templateDocx);
  const backup = p + '.backup.docx';
  if (!fs.existsSync(backup)) {
    res.status(404).json({ error: 'Kein Backup vorhanden' });
    return;
  }
  try {
    fs.copyFileSync(backup, p);
    fs.unlinkSync(backup);
    logger.info('Letter-Template zurückgerollt', { typ });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Fehler beim Rollback Letter-Template', { error: err, typ });
    res.status(500).json({ error: 'Fehler beim Rollback' });
  }
});

export default router;
```

- [ ] **Step 2: Mount in `backend/src/index.ts`**

Add import near the other route imports:

```typescript
import letterTemplatesRoutes from './routes/letterTemplates';
```

Mount under `/api/letter-templates` near the other `app.use('/api/...', ...)` lines:

```typescript
app.use('/api/letter-templates', letterTemplatesRoutes);
```

- [ ] **Step 3: Smoke-test**

```bash
cd backend && npm run dev
# In another shell:
curl -s http://localhost:3004/api/letter-templates \
  -H "Authorization: Bearer $TOKEN" | jq '.[0]'
```

Expected output includes `typ`, `filename`, `size`, `lastModified`, `hasBackup: false`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/letterTemplates.ts backend/src/index.ts
git commit -m "feat(letters): admin routes for template download/upload/rollback"
```

---

## Task 7: Frontend — "DOCX erzeugen" button on `bereit` letters

**Files:**
- Modify: `frontend/src/components/extraction/tabs/AnschreibenTab.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Update `LetterCard` to accept an `onGenerate` callback**

Replace the `LetterCard` function in `AnschreibenTab.tsx`:

```tsx
function LetterCard({
  letter,
  extractionId,
  onGenerate,
}: {
  letter: Standardanschreiben;
  extractionId: number | null;
  onGenerate: (typ: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const st = letter.status || 'fehlt';
  const bgClass =
    st === 'bereit' ? 'bg-ie-green-bg border-ie-green-border'
      : st === 'entfaellt' ? 'bg-ie-blue-bg border-ie-blue-border'
      : 'bg-ie-amber-bg border-ie-amber-border';

  return (
    <div
      className={`border rounded-lg shadow-card p-2.5 px-3.5 mb-2 hover:shadow-card-hover transition-shadow ${bgClass}`}
    >
      <div className="flex justify-between items-center cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div>
          <div className="text-xs font-semibold text-text font-sans">{letter.typ}</div>
          <div className="text-[10px] text-text-dim mt-0.5">An: {letter.empfaenger?.trim() || '—'}</div>
        </div>
        <div className="flex items-center gap-2">
          {st === 'bereit' && extractionId != null && (
            <button
              type="button"
              className="text-[10px] px-2 py-1 rounded bg-ie-green text-white hover:bg-ie-green/90 font-medium"
              onClick={(e) => { e.stopPropagation(); onGenerate(letter.typ); }}
            >
              DOCX erzeugen
            </button>
          )}
          <Badge type={st} />
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border">
          {letter.begruendung && (
            <div className="text-[10px] text-text-dim mb-1">{letter.begruendung}</div>
          )}
          {letter.fehlende_daten?.length > 0 && (
            <div className="text-[10px] text-ie-amber">
              Fehlend: {letter.fehlende_daten.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Extend props and handler on `AnschreibenTab`**

Update the `AnschreibenTabProps` interface:

```tsx
interface AnschreibenTabProps {
  result: ExtractionResult;
  letters: Standardanschreiben[];
  missingInfo: FehlendInfo[];
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
  extractionId: number | null;
}
```

Replace the `AnschreibenTab` function body so the signature accepts `extractionId`, add the download handler, and pass `extractionId` + `handleGenerate` into every `<LetterCard>`:

```tsx
export function AnschreibenTab({ result, letters, missingInfo, onUpdateField, extractionId }: AnschreibenTabProps) {
  const [strafaktePending, setStrafaktePending] = useState<string | null>(null);

  async function handleGenerate(typ: string, extras: Record<string, string> = {}) {
    if (!extractionId) return;
    if (typ.toLowerCase().includes('strafakte') && Object.keys(extras).length === 0) {
      setStrafaktePending(typ);
      return;
    }
    const token = localStorage.getItem('token');
    const resp = await fetch(
      `/api/generate-letter/${extractionId}/${encodeURIComponent(typ)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ extras }),
      },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Unbekannter Fehler' }));
      alert(`Generierung fehlgeschlagen: ${err.error}`);
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${typ.replace(/[^\w-]/g, '_')}_${extractionId}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const bereit = letters.filter(l => l.status === 'bereit');
  const fehlt = letters.filter(l => l.status === 'fehlt');
  const entfaellt = letters.filter(l => l.status === 'entfaellt');

  return (
    <>
      <div className="flex gap-2 mb-3.5">
        <StatsCardSmall label="Bereit" value={bereit.length} colorClass="text-ie-green" />
        <StatsCardSmall label="Daten fehlen" value={fehlt.length} colorClass="text-ie-amber" />
        <StatsCardSmall label="Entfällt" value={entfaellt.length} colorClass="text-ie-blue" />
      </div>

      <FieldChecklist
        title="Pflichtfelder für Anschreiben"
        fields={ANSCHREIBEN_REQUIRED_FIELDS}
        result={result}
        onUpdateField={onUpdateField}
      />

      {bereit.length > 0 && (
        <Section title="Alle Daten vorhanden" icon="✓" count={bereit.length}>
          {bereit.map((l, i) => (
            <LetterCard key={i} letter={l} extractionId={extractionId} onGenerate={(t) => handleGenerate(t)} />
          ))}
        </Section>
      )}
      {fehlt.length > 0 && (
        <Section title="Daten unvollständig" icon="△" count={fehlt.length}>
          {fehlt.map((l, i) => (
            <LetterCard key={i} letter={l} extractionId={extractionId} onGenerate={(t) => handleGenerate(t)} />
          ))}
        </Section>
      )}
      {entfaellt.length > 0 && (
        <Section title="Nicht erforderlich" icon="○" count={entfaellt.length} defaultOpen={false}>
          {entfaellt.map((l, i) => (
            <LetterCard key={i} letter={l} extractionId={extractionId} onGenerate={(t) => handleGenerate(t)} />
          ))}
        </Section>
      )}
      {letters.length === 0 && (
        <div className="text-center py-10 text-text-muted text-xs">
          Keine Anschreiben-Analyse verfügbar.
        </div>
      )}

      {missingInfo.length > 0 && (
        <Section title="Fehlende Informationen" icon="△" count={missingInfo.length} defaultOpen={false}>
          {missingInfo.map((m, i) => {
            const title = typeof m === 'string' ? m : (m.information || m.grund || m.ermittlung_ueber || 'Fehlende Angabe').trim();
            const titleFromGrund = typeof m === 'object' && !m.information?.trim() && m.grund?.trim() === title;
            return (
              <div key={i} className="p-2.5 px-3 mb-1.5 bg-ie-red-bg border border-ie-red-border rounded-md">
                <div className="text-xs text-text font-semibold font-sans">{title}</div>
                {typeof m === 'object' && m.grund && !titleFromGrund && (
                  <div className="text-[10px] text-text-dim mt-0.5">Grund: {m.grund}</div>
                )}
                {typeof m === 'object' && m.ermittlung_ueber && (
                  <div className="text-[10px] text-ie-amber mt-0.5">→ Ermittlung über: {m.ermittlung_ueber}</div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {strafaktePending && (
        <StrafakteInputsModal
          typ={strafaktePending}
          onCancel={() => setStrafaktePending(null)}
          onSubmit={(extrasObj) => {
            const capturedTyp = strafaktePending;
            setStrafaktePending(null);
            handleGenerate(capturedTyp, extrasObj);
          }}
        />
      )}
    </>
  );
}
```

Also add the import for `StrafakteInputsModal` at the top of the file (component itself is created in Task 8):

```tsx
import { StrafakteInputsModal } from '../StrafakteInputsModal';
```

- [ ] **Step 3: Update call site in `DashboardPage.tsx`**

Find the line in `frontend/src/pages/DashboardPage.tsx`:

```tsx
<AnschreibenTab result={result} letters={letters} missingInfo={missingInfo} onUpdateField={updateField} />
```

Replace with (the `extractionId` variable is the same one already used for `loadFromHistory` elsewhere in the page):

```tsx
<AnschreibenTab result={result} letters={letters} missingInfo={missingInfo} onUpdateField={updateField} extractionId={extractionId} />
```

- [ ] **Step 4: Commit**

Note: the file will not compile yet because `StrafakteInputsModal` is created in Task 8. The compile error is expected until Task 8 completes. Do both tasks before re-running the dev server.

```bash
git add frontend/src/components/extraction/tabs/AnschreibenTab.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat(letters): DOCX erzeugen button and generate handler"
```

---

## Task 8: Strafakte modal (3 user-input fields)

**Files:**
- Create: `frontend/src/components/extraction/StrafakteInputsModal.tsx`

- [ ] **Step 1: Create the modal**

`frontend/src/components/extraction/StrafakteInputsModal.tsx`:

```tsx
import { useState } from 'react';

interface Props {
  typ: string;
  onCancel: () => void;
  onSubmit: (extras: Record<string, string>) => void;
}

export function StrafakteInputsModal({ typ, onCancel, onSubmit }: Props) {
  const [person, setPerson] = useState('');
  const [tatvorwurf, setTatvorwurf] = useState('');
  const [gegenstand, setGegenstand] = useState('');

  function submit() {
    onSubmit({
      strafverfahren_person: person.trim(),
      strafverfahren_tatvorwurf: tatvorwurf.trim(),
      strafverfahren_gegenstand: gegenstand.trim(),
    });
  }

  const allFilled = person.trim() && tatvorwurf.trim() && gegenstand.trim();

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-lg shadow-xl max-w-lg w-full p-5">
        <h3 className="text-sm font-semibold mb-1">{typ}: zusätzliche Angaben</h3>
        <p className="text-[11px] text-text-dim mb-4">
          Drei Freitextfelder, die im Brief eingefügt werden. Alle Pflicht.
        </p>
        <label className="block text-[11px] font-medium mb-1">Angeklagte Person</label>
        <input
          type="text"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
          placeholder="z.B. den Geschäftsführer Max Mustermann"
          className="w-full border border-border rounded px-2 py-1 mb-3 text-xs"
        />
        <label className="block text-[11px] font-medium mb-1">Tatvorwurf</label>
        <input
          type="text"
          value={tatvorwurf}
          onChange={(e) => setTatvorwurf(e.target.value)}
          placeholder="z.B. des Betrugs / der Untreue"
          className="w-full border border-border rounded px-2 py-1 mb-3 text-xs"
        />
        <label className="block text-[11px] font-medium mb-1">Erwartete Informationen</label>
        <textarea
          value={gegenstand}
          onChange={(e) => setGegenstand(e.target.value)}
          rows={3}
          placeholder="z.B. Zahlungsströme, Pflichtverletzungen, wirtschaftliche Verhältnisse"
          className="w-full border border-border rounded px-2 py-1 mb-4 text-xs"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-surface-hover"
          >
            Abbrechen
          </button>
          <button
            type="button"
            disabled={!allFilled}
            onClick={submit}
            className="text-xs px-3 py-1.5 rounded bg-ie-green text-white disabled:opacity-40"
          >
            Brief erzeugen
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manual smoke test**

Run `npm run dev` in both `backend/` and `frontend/`. Open a completed extraction in the dashboard, navigate to the Anschreiben tab, click "DOCX erzeugen" on Strafakte-Akteneinsicht (if status `bereit`) — modal appears. Fill the 3 fields, submit — DOCX downloads. Open the DOCX in Word and verify the 3 free-text values appear in the right places in the body paragraph.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/extraction/StrafakteInputsModal.tsx
git commit -m "feat(letters): Strafakte modal for 3 user-input fields"
```

---

## Task 9: AdminPage section for letter templates

**Files:**
- Create: `frontend/src/components/admin/LetterTemplatesSection.tsx`
- Modify: `frontend/src/pages/AdminPage.tsx`

- [ ] **Step 1: Create the section component**

`frontend/src/components/admin/LetterTemplatesSection.tsx`:

```tsx
import { useEffect, useState } from 'react';

interface LetterTemplateInfo {
  typ: string;
  filename: string | null;
  size: number | null;
  lastModified: string | null;
  hasBackup: boolean;
}

export function LetterTemplatesSection() {
  const [list, setList] = useState<LetterTemplateInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function fetchList() {
    const token = localStorage.getItem('token');
    const resp = await fetch('/api/letter-templates', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) setList((await resp.json()) as LetterTemplateInfo[]);
  }
  useEffect(() => { fetchList(); }, []);

  async function download(typ: string) {
    const token = localStorage.getItem('token');
    const resp = await fetch(
      `/api/letter-templates/${encodeURIComponent(typ)}/download`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) { setMessage('Download fehlgeschlagen'); return; }
    const blob = await resp.blob();
    const entry = list.find((l) => l.typ === typ);
    const filename = entry?.filename?.split('/').pop() ?? `${typ}.docx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function upload(typ: string, file: File) {
    setBusy(typ); setMessage(null);
    const token = localStorage.getItem('token');
    const form = new FormData();
    form.append('template', file);
    const resp = await fetch(
      `/api/letter-templates/${encodeURIComponent(typ)}`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Upload fehlgeschlagen' }));
      const missing = err.missing ? ` — fehlend: ${err.missing.join(', ')}` : '';
      setMessage(`${err.error ?? 'Upload fehlgeschlagen'}${missing}`);
    } else {
      setMessage(`${typ}: erfolgreich hochgeladen`);
      fetchList();
    }
    setBusy(null);
  }

  async function rollback(typ: string) {
    setBusy(typ); setMessage(null);
    const token = localStorage.getItem('token');
    const resp = await fetch(
      `/api/letter-templates/${encodeURIComponent(typ)}/rollback`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Rollback fehlgeschlagen' }));
      setMessage(err.error ?? 'Rollback fehlgeschlagen');
    } else {
      setMessage(`${typ}: zurückgerollt`);
      fetchList();
    }
    setBusy(null);
  }

  return (
    <section className="bg-surface rounded-lg shadow-card p-4 mb-4">
      <h2 className="text-sm font-semibold mb-3">Standardschreiben-Vorlagen</h2>
      {message && (
        <div className="text-[11px] bg-ie-amber-bg border border-ie-amber-border rounded p-2 mb-3">
          {message}
        </div>
      )}
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-text-dim">
            <th className="py-1 pr-2">Typ</th>
            <th className="py-1 pr-2">Datei</th>
            <th className="py-1 pr-2">Größe</th>
            <th className="py-1 pr-2">Geändert</th>
            <th className="py-1 text-right">Aktionen</th>
          </tr>
        </thead>
        <tbody>
          {list.map((l) => (
            <tr key={l.typ} className="border-t border-border">
              <td className="py-1.5 pr-2 font-medium">{l.typ}</td>
              <td className="py-1.5 pr-2 text-text-dim">{l.filename?.split('/').pop() ?? '—'}</td>
              <td className="py-1.5 pr-2 text-text-dim">{l.size ? `${(l.size / 1024).toFixed(1)} KB` : '—'}</td>
              <td className="py-1.5 pr-2 text-text-dim">
                {l.lastModified ? new Date(l.lastModified).toLocaleString('de-DE') : '—'}
              </td>
              <td className="py-1.5 text-right">
                <button
                  type="button"
                  onClick={() => download(l.typ)}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-surface-hover mr-1"
                >
                  Download
                </button>
                <label className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-surface-hover mr-1 cursor-pointer inline-block">
                  Upload
                  <input
                    type="file"
                    accept=".docx"
                    className="hidden"
                    disabled={busy === l.typ}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload(l.typ, f);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={!l.hasBackup || busy === l.typ}
                  onClick={() => rollback(l.typ)}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-surface-hover disabled:opacity-30"
                >
                  Rollback
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 2: Render in AdminPage**

Open `frontend/src/pages/AdminPage.tsx`. Add at the top with the other component imports:

```tsx
import { LetterTemplatesSection } from '../components/admin/LetterTemplatesSection';
```

Add `<LetterTemplatesSection />` inside the admin page JSX, near the existing Gutachten / Kanzlei sections (or at the bottom of the admin content if no Gutachten section lives in this page).

- [ ] **Step 3: Manual smoke test**

With both servers running, open the admin page. Verify 10 rows appear, each with Download / Upload / Rollback buttons. Download a DOCX, make a trivial edit in Word, Upload back. Verify `.backup.docx` appears in `standardschreiben/templates/` and Rollback button becomes enabled. Click Rollback — backup restored. Try uploading a DOCX that misses a required placeholder (delete one FELD from body in Word first) — expect the error banner listing missing placeholders.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/admin/LetterTemplatesSection.tsx frontend/src/pages/AdminPage.tsx
git commit -m "feat(letters): admin UI for template upload/download/rollback"
```

---

## Task 10: End-to-end verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run full test suite**

```bash
cd backend && npm run test
```

Expected: all tests green (including new `genderHelpers.test.ts` and `letterGenerator.test.ts`).

- [ ] **Step 2: Golden-path UI test**

Start backend + frontend in dev. Upload a completed test PDF (Geldt or similar), wait for extraction to finish.

Anschreiben tab:
- Verify at least 5 letters show `bereit` status.
- For each `bereit` letter (except Strafakte): click "DOCX erzeugen" → DOCX downloads → open in Word → verify placeholder substitution:
  - Aktenzeichen, Gericht, Beschlussdatum present
  - Schuldnername, Adresse present
  - Gender articles (der/die, den/die, dem/der) correct for schuldner.geschlecht
  - Verwalter name + Art + Diktatzeichen present
  - NO raw `FELD_*` leakage anywhere in the document
- Strafakte-Akteneinsicht: click button → modal opens → fill 3 fields → submit → DOCX downloads → verify all 3 inputs appear in the document body.

Admin page:
- Standardschreiben-Vorlagen section visible with 10 rows.
- Download one template, edit trivially in Word, upload back.
- Verify Rollback button enables, click, verify file reverts.
- Try uploading an empty DOCX (e.g. a Word doc without FELD_*) — expect error listing missing placeholders.

- [ ] **Step 3: Document the delta in `CLAUDE.md`**

Append to the root `CLAUDE.md` under the "Backend" section (near the `generateLetter` description):

```markdown
### Standardschreiben Generation (`src/routes/generateLetter.ts` + `src/utils/letterGenerator.ts`)
- Loads DOCX from `standardschreiben/templates/<typ>.docx` via `checklisten.json` templateDocx
- Mapping in `standardschreiben/platzhalter-mapping.json` (32 fields: path / computed / verwalter / static / input)
- XML text replacement reuses `processDocxParagraphs` from `gutachtenGenerator.ts` (handles Word run-splitting)
- Strafakte requires `extras.strafverfahren_{person,tatvorwurf,gegenstand}` in request body
- Admin upload/rollback at `/api/letter-templates/:typ` (required placeholders derived from current template)
```

- [ ] **Step 4: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Standardschreiben generation pipeline"
```
