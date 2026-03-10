# InsolvenzExtraktor – Code Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Vier priorisierte Lücken aus dem Code-Review schließen: Quellen-Highlight-Bugs, History-Flow, DOCX-Generierung und CDN-Worker-Aufräumen.

**Architecture:** Drei Frontend-Patches (DataField, PdfViewer, DashboardPage) + ein neues Backend-Route-Modul für DOCX-Generierung (docxtemplater) + DOCX-Templates als einmalige manuelle Konvertierung.

**Tech Stack:** React 18 + TypeScript, Express 4, docxtemplater + pizzip, react-pdf + mark.js, SQLite via better-sqlite3

---

## Fortschritts-Tracking

Nach jedem Task: kurzes Code-Review mit `superpowers:requesting-code-review` Skill.

---

## Task 1: parsePageNumber robuster machen

**Ziel:** Seitenreferenzen in allen gängigen deutschen/englischen Formaten erkennen.

**Dateien:**
- Modify: `frontend/src/components/extraction/DataField.tsx:26-28`

**Hintergrund:**
Aktuelle Regex: `/Seiten?\s+(\d+)/i` – erkennt nur `Seite 3` und `Seiten 3-5`.
Nicht erkannt: `S. 3`, `S.3`, `S3`, `s. 3`, `page 3`, `p. 3` sowie mehrere Muster in einem Quelle-String.

**Step 1: Fehlschlagende Fälle manuell prüfen**

Öffne `frontend/src/components/extraction/DataField.tsx`. Zeile 27 zeigt die aktuelle Regex.
Öffne die Browser-DevTools → Console und teste:
```js
// Alle diese sollen eine Seitenzahl liefern:
['Seite 3', 'Seiten 3-5', 'S. 3', 'S.3', 'S3', 's.3', 'page 3', 'p. 3', 'S 3', 'Seite 12, Beschluss'].forEach(s => {
  const m = s.match(/Seiten?\s+(\d+)/i);
  console.log(s, '->', m?.[1] ?? 'NULL');
});
```
Erwartet: die letzten fünf geben `NULL` zurück.

**Step 2: Neue robuste Regex implementieren**

In `frontend/src/components/extraction/DataField.tsx`, ersetze Zeile 25-29:

```typescript
/** Extract page number from quelle string.
 *  Handles: Seite 3, Seiten 3-5, S. 3, S.3, S3, page 3, p. 3, p.3
 */
function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}
```

**Step 3: Manuell im Browser prüfen**

Dev-Server starten (`cd frontend && npm run dev`), Demo laden, auf einen `[S.X]`-Button klicken.
Erwartung: PDF scrollt zur richtigen Seite.

**Step 4: Commit**

```bash
git add frontend/src/components/extraction/DataField.tsx
git commit -m "fix: robustere Seitenreferenz-Erkennung in parsePageNumber (S., page, p.)"
```

---

## Task 2: Highlight-Overlay Fallback und Textlayer-Styling

**Ziel:** Wenn mark.js keinen Match findet (Zeilenumbrüche, Unicode-Varianten), trotzdem zur Seite navigieren ohne Fehler. Highlight-Overlay soll nicht verschoben wirken.

**Dateien:**
- Modify: `frontend/src/components/pdf/PdfViewer.tsx:126-153`
- Modify: `frontend/src/index.css` (oder Tailwind-Config, wo `.source-highlight` definiert ist)

**Step 1: Bestehende highlight-Styles prüfen**

```bash
grep -n "source-highlight\|textContent\|textLayer" frontend/src/index.css frontend/src/components/pdf/PdfViewer.tsx
```

**Step 2: Highlight-Effekt in applyHighlight verbessern**

In `PdfViewer.tsx`, ersetze den `applyHighlight`-Block (Zeilen ~132-144):

```typescript
const applyHighlight = (): boolean => {
  const textLayer = pageEl.querySelector('.textLayer') as HTMLElement | null;
  if (!textLayer) return false;

  const mark = new Mark(textLayer);
  mark.unmark({ className: 'source-highlight' });

  let found = false;
  try {
    const escaped = escapeForRegex(text);
    mark.markRegExp(new RegExp(escaped, 'gi'), {
      className: 'source-highlight',
      done: (count) => { found = count > 0; },
    });
  } catch {
    // Regex ungültig – Fallback auf einfaches mark()
    mark.mark(text, {
      className: 'source-highlight',
      separateWordSearch: false,
      done: (count) => { found = count > 0; },
    });
  }

  // Wenn mark.js nichts findet: kein Fehler, Seite wurde bereits gescrollt
  return true; // applyHighlight war ausführbar (auch wenn 0 Treffer)
};
```

**Step 3: Highlight-CSS prüfen und korrigieren**

Suche in `frontend/src/index.css` nach `.source-highlight`. Sollte so aussehen (ohne `padding` das den Span verschiebt):

```css
.source-highlight {
  background: rgba(59, 130, 246, 0.35);  /* ie-blue mit Transparenz */
  border-radius: 2px;
  /* KEIN padding – sonst verschiebt sich der Textlayer-Span */
  color: inherit;
}
```

Falls ein `padding` gesetzt ist, entfernen.

**Step 4: TextLayer-Opacity prüfen**

In `frontend/src/index.css` nach `.react-pdf__Page__textContent` suchen. Falls `opacity` gesetzt ist:
- Wert auf `0.2` oder `0.25` setzen (sichtbar genug für Debug, unauffällig für Nutzer)
- Bei aktivem Highlight: keine Änderung nötig, das Highlight hebt sich durch Hintergrundfarbe ab

**Step 5: Manuell testen**

Demo laden → Schuldner-Tab → Name anklicken `[S.X]` → prüfen:
- [ ] PDF scrollt zur Seite
- [ ] Highlight erscheint ohne Versatz
- [ ] Kein JavaScript-Fehler in der Console

**Step 6: Commit**

```bash
git add frontend/src/components/pdf/PdfViewer.tsx frontend/src/index.css
git commit -m "fix: highlight-Fallback wenn mark.js keinen Match findet, CSS-Overlay ohne padding"
```

---

## Task 3: History-Flow – Extraktion aus URL laden

**Ziel:** Klick auf History-Eintrag (`/dashboard?id=3`) lädt die Extraktion aus dem Backend und zeigt Ergebnisse ohne Datei-Upload.

**Dateien:**
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Modify: `frontend/src/hooks/useExtraction.ts`

**Hintergrund:**
- `HistoryPage.tsx:53` navigiert zu `/dashboard?id=${item.id}`
- `DashboardPage.tsx` liest den URL-Parameter `id` aktuell nicht
- `GET /api/history/:id` existiert bereits und gibt `ExtractionResponse` zurück
- Die temporäre PDF-Datei wird nach der Extraktion gelöscht → kein PdfViewer für History-Einträge

**Step 1: useExtraction-Hook – loadFromHistory hinzufügen**

Öffne `frontend/src/hooks/useExtraction.ts`. Lese die Datei vollständig.

Am Ende des Hooks (vor dem `return`), neue Funktion hinzufügen:

```typescript
const loadFromHistory = useCallback(async (id: number) => {
  setState(s => ({ ...s, loading: true, error: null, progress: 'Lade Verlauf…', progressPercent: 50 }));
  try {
    const { data } = await apiClient.get(`/history/${id}`);
    setState({
      loading: false,
      progress: '',
      progressPercent: 100,
      result: data.result,
      error: null,
      extractionId: data.id,
      statsFound: data.statsFound,
      statsMissing: data.statsMissing,
      statsLettersReady: data.statsLettersReady,
      processingTimeMs: data.processingTimeMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Fehler beim Laden des Verlaufs';
    setState(s => ({ ...s, loading: false, error: msg, progress: '' }));
  }
}, []);
```

Im `return`-Statement `loadFromHistory` hinzufügen.

**Step 2: DashboardPage – URL-Parameter lesen**

In `DashboardPage.tsx`, nach den Imports ergänzen:

```typescript
import { useSearchParams } from 'react-router-dom';
```

In der Komponente, nach der `useExtraction`-Zeile:

```typescript
const [searchParams] = useSearchParams();
const historyId = searchParams.get('id');

// Beim ersten Render: History-Extraktion laden
useEffect(() => {
  if (historyId && !result && !loading) {
    loadFromHistory(parseInt(historyId, 10));
  }
}, [historyId]); // eslint-disable-line react-hooks/exhaustive-deps
```

Und `loadFromHistory` aus `useExtraction` destructuren:
```typescript
const { loading, progress, progressPercent, result, error, extract, reset, loadDemo, loadFromHistory } = useExtraction();
```

**Step 3: Anzeige ohne Datei**

Die Bedingung `result && file` in `DashboardPage.tsx:130` muss angepasst werden – bei History-Einträgen gibt es keine `file`.

Ersetze Zeile 130-134:

```tsx
{result && file ? (
  <PdfViewer file={file}>
    {resultsContent}
  </PdfViewer>
) : result && !file ? (
  // History-Modus: kein PdfViewer, aber Ergebnisse anzeigen
  <div className="max-w-[1050px] mx-auto p-5 px-6">
    <div className="mb-3 p-2 px-3 bg-surface border border-border rounded-sm text-[10px] text-text-muted flex items-center gap-2">
      <span className="text-ie-amber">⚠</span>
      Verlaufs-Ansicht · PDF nicht verfügbar (wurde nach Extraktion gelöscht)
      <button
        onClick={handleNewFile}
        className="ml-auto px-2 py-0.5 border border-border rounded-sm hover:border-accent hover:text-accent transition-colors"
      >
        NEUE ANALYSE
      </button>
    </div>
    {resultsContent}
  </div>
) : (
```

**Step 4: Manuell testen**

1. Mindestens eine Extraktion durchführen
2. Zur History-Seite navigieren
3. Eintrag anklicken
4. Erwartung: `/dashboard?id=X` öffnet Ergebnisse, Banner „PDF nicht verfügbar" sichtbar, Tabs funktionieren

**Step 5: Commit**

```bash
git add frontend/src/hooks/useExtraction.ts frontend/src/pages/DashboardPage.tsx
git commit -m "fix: History-Klick lädt Extraktion aus URL-Parameter ?id= (ohne PdfViewer)"
```

---

## Task 4: DOCX-Workflow – Vorbereitung (Templates + Mapping)

**Ziel:** Basis für die DOCX-Generierung legen: Packages installieren, Mapping-Datei anlegen, Template-Platzhalter dokumentieren.

**Dateien:**
- Create: `standardschreiben/platzhalter-mapping.json`
- Modify: `backend/package.json` (docxtemplater, pizzip)

### 4.1 – Packages installieren

```bash
cd backend
npm install docxtemplater pizzip
npm install --save-dev @types/pizzip
```

Prüfen: `backend/node_modules/docxtemplater/` existiert.

### 4.2 – DOCX-Templates vorbereiten (manueller Schritt)

**Voraussetzung:** Die 10 PDFs in `standardschreiben/` müssen als DOCX mit Platzhaltern `{FELD_*}` vorliegen.

**Schritte (einmalig, außerhalb des Codes):**
1. Jede PDF in ein DOCX konvertieren (LibreOffice, Word oder online-Konverter)
2. Alle variablen Felder durch `{FELD_Schuldner_Name}` etc. ersetzen (ohne `<>` oder `[]`)
3. DOCX-Dateien in `standardschreiben/` ablegen mit gleichem Basename, Endung `.docx`

**Dateinamen-Konvention:**
| PDF | DOCX |
|-----|------|
| `Bankenanfrage.pdf` | `Bankenanfrage.docx` |
| `Anfrage_ans_Finanzamt.pdf` | `Anfrage_ans_Finanzamt.docx` |
| … | … |

**Bekannte Platzhalter (aus Kunden-PDFs, Beispiel Finanzamt):**
```
{FELD_Bet_AnredeHoeflichOV}     – Anrede des Beteiligten (z.B. "Sehr geehrte Damen und Herren")
{FELD_Akte_LastGAW}             – Beschlussdatum (letzter Gerichtstermin)
{FELD_Schuldner_Artikel}        – Artikel "der" oder "die"
{FELD_Schuldners_Schuldnerin}   – "Schuldners" oder "Schuldnerin"
{FELD_Schuldner_der_die}        – "der" oder "die"
{FELD_Bet_GrussBriefende}       – Grußformel ("Mit freundlichen Grüßen")
{FELD_Verwalter_Diktatzeichen}  – Kürzel des Verwalters
{FELD_Verwalter_Name}           – Name des Verwalters/Insolvenzverwalters
{FELD_Verwalter_Art}            – "Insolvenzverwalter" / "vorläufiger Insolvenzverwalter"
{FELD_Schuldner_Name}           – Nachname
{FELD_Schuldner_Vorname}        – Vorname
{FELD_Schuldner_Adresse}        – Vollständige Adresse (Straße, PLZ, Ort)
{FELD_Akte_Aktenzeichen}        – Aktenzeichen (z.B. "14 IN 123/24")
{FELD_Akte_Gericht}             – Gerichtsname
{FELD_Schuldner_Firma}          – Firmenname (bei Unternehmensinsolvenzen)
{FELD_Schuldner_Betriebsstaette}– Betriebsstättenadresse
{FELD_Schuldner_Geburtsdatum}   – Geburtsdatum (TT.MM.JJJJ)
{FELD_Schuldner_HRB}            – Handelsregisternummer
```

### 4.3 – Platzhalter-Mapping anlegen

Datei anlegen: `standardschreiben/platzhalter-mapping.json`

```json
{
  "_version": "1.0",
  "_beschreibung": "Mapping: FELD_* → ExtractionResult-Pfad oder computed",
  "felder": {
    "FELD_Akte_Aktenzeichen":       { "path": "verfahrensdaten.aktenzeichen.wert" },
    "FELD_Akte_Gericht":            { "path": "verfahrensdaten.gericht.wert" },
    "FELD_Akte_LastGAW":            { "path": "verfahrensdaten.beschlussdatum.wert" },
    "FELD_Schuldner_Name":          { "path": "schuldner.name.wert" },
    "FELD_Schuldner_Vorname":       { "path": "schuldner.vorname.wert" },
    "FELD_Schuldner_Adresse":       { "path": "schuldner.aktuelle_adresse.wert" },
    "FELD_Schuldner_Geburtsdatum":  { "path": "schuldner.geburtsdatum.wert" },
    "FELD_Schuldner_Firma":         { "path": "schuldner.firma.wert" },
    "FELD_Schuldner_Betriebsstaette": { "path": "schuldner.betriebsstaette_adresse.wert" },
    "FELD_Schuldner_HRB":           { "path": "schuldner.handelsregisternummer.wert" },
    "FELD_Schuldner_Artikel":       { "computed": "geschlecht_artikel" },
    "FELD_Schuldner_der_die":       { "computed": "geschlecht_der_die" },
    "FELD_Schuldners_Schuldnerin":  { "computed": "geschlecht_genitiv" },
    "FELD_Verwalter_Name":          { "path": "antragsteller.name.wert" },
    "FELD_Verwalter_Art":           { "static": "Insolvenzverwalter" },
    "FELD_Verwalter_Diktatzeichen": { "computed": "verwalter_kuerzel" },
    "FELD_Bet_AnredeHoeflichOV":    { "static": "Sehr geehrte Damen und Herren" },
    "FELD_Bet_GrussBriefende":      { "static": "Mit freundlichen Grüßen" }
  }
}
```

**Commit:**
```bash
git add standardschreiben/platzhalter-mapping.json backend/package.json backend/package-lock.json
git commit -m "feat: DOCX-Platzhalter-Mapping und docxtemplater installiert"
```

---

## Task 5: DOCX-Workflow – Backend-Route

**Ziel:** Route `POST /api/generate-letter/:extractionId/:typ` liefert ein befülltes DOCX zum Download.

**Dateien:**
- Create: `backend/src/routes/generateLetter.ts`
- Create: `backend/src/utils/docxGenerator.ts`
- Modify: `backend/src/index.ts`

### 5.1 – docxGenerator-Utility

Neue Datei: `backend/src/utils/docxGenerator.ts`

```typescript
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult } from '../types/extraction';

// Pfad zum standardschreiben-Verzeichnis
const TEMPLATES_DIR = path.resolve(__dirname, '../../../standardschreiben');
const MAPPING_PATH = path.join(TEMPLATES_DIR, 'platzhalter-mapping.json');

interface FieldMapping {
  path?: string;
  computed?: string;
  static?: string;
}

interface MappingFile {
  felder: Record<string, FieldMapping>;
}

/** Liest einen verschachtelten Pfad wie "schuldner.name.wert" aus einem Objekt */
function getByPath(obj: unknown, dotPath: string): string {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }
  return current != null ? String(current) : '';
}

/** Berechne Genus-abhängige Felder */
function computeField(key: string, result: ExtractionResult): string {
  const geschlecht = getByPath(result, 'schuldner.geschlecht.wert').toLowerCase();
  const weiblich = geschlecht === 'weiblich' || geschlecht === 'w';

  switch (key) {
    case 'geschlecht_artikel':        return weiblich ? 'die' : 'der';
    case 'geschlecht_der_die':        return weiblich ? 'die' : 'der';
    case 'geschlecht_genitiv':        return weiblich ? 'Schuldnerin' : 'Schuldners';
    case 'verwalter_kuerzel': {
      const name = getByPath(result, 'antragsteller.name.wert');
      // Kürzel = erste Buchstaben des Vor- und Nachnamens
      const parts = name.split(' ').filter(Boolean);
      return parts.map(p => p[0]?.toUpperCase() ?? '').join('');
    }
    default: return '';
  }
}

/** Befüllt ein DOCX-Template mit Werten aus ExtractionResult */
export function generateDocx(templateFilename: string, result: ExtractionResult): Buffer {
  const templatePath = path.join(TEMPLATES_DIR, templateFilename);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template nicht gefunden: ${templateFilename}`);
  }

  const mapping: MappingFile = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8'));
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // Fehlende Platzhalter als leerer String statt Fehler
    nullGetter: () => '',
  });

  // Alle gemappten Felder befüllen
  const data: Record<string, string> = {};
  for (const [feld, def] of Object.entries(mapping.felder)) {
    if (def.static) {
      data[feld] = def.static;
    } else if (def.path) {
      data[feld] = getByPath(result, def.path);
    } else if (def.computed) {
      data[feld] = computeField(def.computed, result);
    }
  }

  doc.render(data);

  return doc.getZip().generate({ type: 'nodebuffer' }) as Buffer;
}
```

### 5.2 – Route anlegen

Neue Datei: `backend/src/routes/generateLetter.ts`

```typescript
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { generateDocx } from '../utils/docxGenerator';
import type { ExtractionResult } from '../types/extraction';

const router = Router();

/**
 * POST /api/generate-letter/:extractionId/:typ
 * Liefert ein befülltes DOCX für den angegebenen Anschreiben-Typ.
 * Der typ-Parameter ist URL-encoded, z.B. "Bankenauskunft".
 */
router.post('/:extractionId/:typ', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const extractionId = parseInt(req.params['extractionId'] ?? '', 10);
  const typ = decodeURIComponent(req.params['typ'] ?? '');

  if (isNaN(extractionId) || !typ) {
    res.status(400).json({ error: 'Ungültige Parameter' });
    return;
  }

  // Extraktion laden (nur eigene)
  const row = db.prepare(
    `SELECT result_json FROM extractions WHERE id = ? AND user_id = ? AND status = 'completed'`
  ).get(extractionId, userId) as { result_json: string } | undefined;

  if (!row?.result_json) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  const result: ExtractionResult = JSON.parse(row.result_json);

  // Passendes Anschreiben-Objekt finden
  const letter = result.standardanschreiben?.find(
    l => l.typ === typ || l.typ?.toLowerCase() === typ.toLowerCase()
  );

  if (!letter) {
    res.status(404).json({ error: `Anschreiben-Typ nicht gefunden: ${typ}` });
    return;
  }

  if (letter.status !== 'bereit') {
    res.status(422).json({ error: `Anschreiben nicht bereit (Status: ${letter.status})` });
    return;
  }

  // Template-Dateinamen aus checklisten.json ermitteln
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const checklisten = require('../../../standardschreiben/checklisten.json') as {
    anschreiben: Array<{ typ: string; templatePdf?: string; typAliases?: string[] }>;
  };

  const checkItem = checklisten.anschreiben.find(
    c => c.typ === typ || c.typAliases?.includes(typ)
  );

  if (!checkItem?.templatePdf) {
    res.status(404).json({ error: `Kein Template für Typ: ${typ}` });
    return;
  }

  // .pdf durch .docx ersetzen
  const templateDocx = checkItem.templatePdf.replace(/\.pdf$/i, '.docx');

  try {
    const buffer = generateDocx(templateDocx, result);
    const safeName = `${typ.replace(/[^a-zA-Z0-9_-]/g, '_')}_${extractionId}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generierung fehlgeschlagen';
    res.status(500).json({ error: msg });
  }
});

export default router;
```

### 5.3 – Route in index.ts registrieren

In `backend/src/index.ts`, nach dem historyRoutes-Import ergänzen:

```typescript
import generateLetterRoutes from './routes/generateLetter';
```

Und nach Zeile 27 (`app.use('/api/history', historyRoutes);`):

```typescript
app.use('/api/generate-letter', generateLetterRoutes);
```

### 5.4 – TypeScript bauen und Fehler beheben

```bash
cd backend && npm run build 2>&1 | head -50
```

Erwartung: keine Fehler. Sonst Typfehler beheben.

**Commit:**
```bash
git add backend/src/utils/docxGenerator.ts backend/src/routes/generateLetter.ts backend/src/index.ts
git commit -m "feat: DOCX-Generierung über POST /api/generate-letter/:id/:typ"
```

---

## Task 6: DOCX-Workflow – Frontend-Button in AnschreibenTab

**Ziel:** Für jeden Anschreiben mit Status `bereit` einen „Erstellen"-Button einblenden, der das DOCX herunterlädt.

**Dateien:**
- Modify: `frontend/src/components/extraction/tabs/AnschreibenTab.tsx`

**Hintergrund:**
- `AnschreibenTab` erhält `letters: Standardanschreiben[]` als Prop
- Aktuell kein `extractionId` vorhanden in der Prop – muss ergänzt werden
- API-Call: `POST /api/generate-letter/${extractionId}/${encodeURIComponent(typ)}`
- Download: Blob-Response im Browser triggern

**Step 1: extractionId als Prop ergänzen**

In `AnschreibenTab.tsx`, Interface ändern:

```typescript
interface AnschreibenTabProps {
  letters: Standardanschreiben[];
  extractionId: number;
}
```

Export-Signatur:

```typescript
export function AnschreibenTab({ letters, extractionId }: AnschreibenTabProps) {
```

**Step 2: LetterCard – Download-Button hinzufügen**

`LetterCard`-Komponente anpassen:

```typescript
function LetterCard({ letter, extractionId }: { letter: Standardanschreiben; extractionId: number }) {
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const st = letter.status || 'fehlt';

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Expand nicht triggern
    if (downloading) return;
    setDownloading(true);
    try {
      const { apiClient } = await import('../../../api/client');
      const response = await apiClient.post(
        `/generate-letter/${extractionId}/${encodeURIComponent(letter.typ)}`,
        {},
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(response.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${letter.typ.replace(/[^a-zA-Z0-9_-]/g, '_')}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert(`Fehler beim Erstellen von "${letter.typ}"`);
    } finally {
      setDownloading(false);
    }
  };

  // ... JSX: In der Header-Zeile der Karte, neben Badge, für bereit-Status:
  // <button onClick={handleDownload} ...>
```

Im JSX der `LetterCard`, nach `<Badge type={st} />`:

```tsx
{st === 'bereit' && (
  <button
    onClick={handleDownload}
    disabled={downloading}
    title="DOCX erstellen und herunterladen"
    className="ml-2 px-2 py-0.5 text-[9px] border border-ie-green-border text-ie-green rounded-sm hover:bg-ie-green-bg transition-colors disabled:opacity-50 disabled:cursor-wait font-mono"
  >
    {downloading ? '…' : '↓ DOCX'}
  </button>
)}
```

**Step 3: extractionId aus DashboardPage übergeben**

In `DashboardPage.tsx`, `extractionId` aus `useExtraction` destructuren (prüfen ob vorhanden) und an `AnschreibenTab` weitergeben:

```tsx
{tab === 'briefe' && (
  <AnschreibenTab letters={letters} extractionId={extractionId ?? 0} />
)}
```

**Step 4: Manuell testen**

1. Eine Extraktion starten
2. Tab „Anschreiben" öffnen
3. Auf „↓ DOCX" bei einem bereit-Brief klicken
4. Erwartung: `.docx`-Datei wird heruntergeladen

**Hinweis:** Wenn noch keine DOCX-Templates in `standardschreiben/` liegen, kommt ein 500-Fehler mit `Template nicht gefunden`. Das ist korrekt – Templates müssen manuell erstellt werden (Task 4).

**Step 5: Commit**

```bash
git add frontend/src/components/extraction/tabs/AnschreibenTab.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat: DOCX-Download-Button in AnschreibenTab für Briefe mit Status bereit"
```

---

## Task 7: Postinstall / Worker-Copy entfernen (Niedrig)

**Ziel:** Build-Artefakt und Postinstall-Skript entfernen, da PdfViewer den CDN-Worker nutzt.

**Dateien:**
- Modify: `frontend/package.json` (postinstall entfernen falls vorhanden)
- Modify: `frontend/Dockerfile` (Worker-Copy entfernen falls vorhanden)
- Delete: `frontend/public/pdf.worker.min.mjs` (falls vorhanden)

**Step 1: Prüfen was existiert**

```bash
ls frontend/public/
cat frontend/package.json | grep -A3 postinstall
grep -n "pdf.worker" frontend/Dockerfile frontend/Dockerfile.dev 2>/dev/null
```

**Step 2: Aufräumen**

Falls `frontend/public/pdf.worker.min.mjs` existiert:
```bash
rm frontend/public/pdf.worker.min.mjs
```

Falls `postinstall`-Script in `frontend/package.json` auf den Worker verweist: entfernen.

Falls `COPY` für die Worker-Datei in einem Dockerfile vorhanden: entfernen.

**Step 3: CDN-Worker verifizieren**

```bash
grep -n "workerSrc" frontend/src/components/pdf/PdfViewer.tsx
```
Erwartet: `https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs`

**Step 4: Build-Test**

```bash
cd frontend && npm run build 2>&1 | tail -20
```
Keine Fehler erwartet.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: Worker-Copy und postinstall entfernen – CDN-Worker aktiv"
```

---

## Zusammenfassung der Änderungen

| # | Task | Dateien | Prio |
|---|------|---------|------|
| 1 | parsePageNumber robuster | DataField.tsx | Hoch |
| 2 | Highlight-Fallback + CSS | PdfViewer.tsx, index.css | Hoch |
| 3 | History-Flow URL-Parameter | useExtraction.ts, DashboardPage.tsx | Hoch |
| 4 | DOCX Mapping + Templates | platzhalter-mapping.json, Packages | Hoch |
| 5 | DOCX Backend-Route | docxGenerator.ts, generateLetter.ts, index.ts | Hoch |
| 6 | DOCX Frontend-Button | AnschreibenTab.tsx, DashboardPage.tsx | Hoch |
| 7 | Worker-Cleanup | package.json, Dockerfiles | Niedrig |

**Wichtigste manuelle Voraussetzung (außerhalb des Codes):**
Die 10 PDF-Templates in `standardschreiben/` müssen als `.docx` mit `{FELD_*}`-Platzhaltern vorliegen, bevor Task 5+6 funktionstüchtig sind. Task 1-3 und 7 sind unabhängig davon sofort umsetzbar.
