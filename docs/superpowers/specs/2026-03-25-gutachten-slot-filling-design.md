# Gutachten Slot-Filling: KI-gestützte Befüllung von [...]-Platzhaltern

## Problem

Die Gutachten-Vorlagen enthalten neben den 28 `FELD_*`-Platzhaltern ~100+ `[…]`-Stellen, die kontextabhängig sind. Derselbe `[…]`-Marker hat je nach Position eine andere Bedeutung (Datum, Betrag, Name, etc.). Viele dieser Stellen können aus den extrahierten Daten (ExtractionResult + AktivaAnalyse) automatisch befüllt werden.

## Lösung: Nummerierte Slots + KI-Zuordnung

### Ablauf

```
1. Nutzer klickt "Gutachten vorbereiten" im GutachtenTab
     ↓
2. Backend: Template laden → FELD_* ersetzen → Slots extrahieren → KI füllt Slots
     ↓
3. Backend gibt Slot-Liste mit vorgeschlagenen Werten zurück (JSON)
     ↓
4. Frontend: GutachtenDialog zeigt alle Slots als editierbare Felder
   - Grün: KI hat Wert aus Akte gefunden
   - Gelb: [TODO: ...] — nicht automatisch füllbar
   - Nutzer kann jeden Wert ändern/korrigieren
     ↓
5. Nutzer bestätigt + klickt "Generieren"
     ↓
6. Backend: Setzt finale Werte in DOCX ein → Download
```

### Slot-Extraktion

Jedes `[…]`, `[...]`, `[Text in Klammern]` und `xxxx`-Muster wird durch `[[SLOT_NNN]]` ersetzt. Pro Slot wird gespeichert:

```typescript
interface GutachtenSlot {
  id: string;           // "SLOT_001"
  context: string;      // Umgebender Satz: "beschäftigt [[SLOT_023]] Arbeitnehmer"
  original: string;     // Originaltext: "[…]" oder "[Branche]" oder "xxxx"
  value: string;        // KI-vorgeschlagener Wert oder "[TODO: ...]"
  status: 'filled' | 'todo' | 'editorial';
}
```

`editorial`-Status für redaktionelle Anweisungen wie `[wenn größerer Betrieb]`, die keine Datenlücken sind sondern Strukturhinweise für den Anwalt.

### XML Run-Splitting (KRITISCH)

**Sowohl `extractSlots` als auch `applySlots` MÜSSEN die Paragraph-Flattening-Strategie verwenden** — identisch zu `replaceFieldsInXml` in `gutachtenGenerator.ts`. Word splittet `[…]` häufig über mehrere `<w:r>`-Runs:

```xml
<w:r><w:t>[</w:t></w:r><w:r><w:t>…</w:t></w:r><w:r><w:t>]</w:t></w:r>
```

Die Logik muss:
1. Pro `<w:p>` (Paragraph): alle `<w:t>`-Texte konkatenieren
2. Auf dem konkatenierten Text die Slot-Regex anwenden
3. Ergebnis in den ersten `<w:t>` schreiben, alle anderen leeren

**Refactoring**: Die paragraph-flattening Logik aus `replaceFieldsInXml` wird in eine gemeinsame Hilfsfunktion `processDocxParagraphs(xml, transformFn)` extrahiert, die sowohl FELD_*-Replacement als auch Slot-Extraktion/Anwendung nutzen.

### Slot-Regex-Muster

```typescript
const SLOT_PATTERNS = [
  /\[\u2026\]/g,                           // […] (Unicode-Ellipsis)
  /\[\.{3}\]/g,                            // [...] (drei Punkte)
  /\[(?!TODO:)[^\[\]]{1,80}\]/g,           // [beliebiger Text] — NICHT [TODO: ...]
  /\bx{4,}\b/gi,                           // xxxx, xxxxx, xxxxxx
];
```

**Wichtig**: Die dritte Regex hat einen Negative Lookahead `(?!TODO:)`, damit unsere eigenen `[TODO: ...]`-Marker nicht als neue Slots erkannt werden. Dies verhindert Double-Counting bei einem erneuten `prepare`-Call.

### KI-Befüllung (Claude API-Call)

Prompt erhält:
- Slot-Liste mit Kontext (ID + umgebender Satz + Originaltext)
- **Nur `.wert`-Werte** aus ExtractionResult — NICHT die vollen `SourcedValue`-Objekte mit `quelle`/`verifiziert`/`pruefstatus`. Das reduziert Tokens (~4-6 KB statt ~12 KB) und vermeidet Verwirrung der KI durch interne Metadaten.
- AktivaAnalyse (nur `positionen[].beschreibung.wert`, `geschaetzter_wert.wert`, `kategorie` + Insolvenzanalyse)

Antwort: JSON-Map `{ "SLOT_001": "Wert", "SLOT_002": "[TODO: Lohnrückstände angeben]" }`

Regeln für die KI:
- Nur Werte aus ExtractionResult/AktivaAnalyse verwenden, nichts erfinden
- Datumsformat TT.MM.JJJJ, Beträge in deutscher Schreibweise
- Redaktionelle Anweisungen (erkennbar an Formulierungen wie "wenn...", "ggf.", "ansonsten") als `[TODO: ...]` markieren
- `xxxx`-Stellen die auf zukünftige Ereignisse verweisen: `[TODO: Datum eintragen]`
- Bei Unsicherheit: `[TODO: Beschreibung]` statt falschen Wert

### API-Endpoints

Der bestehende Endpoint `POST /:extractionId` wird **entfernt** und durch zwei neue ersetzt:

**Prepare (Slot-Vorschau):**
```
POST /api/generate-gutachten/:extractionId/prepare
Body: { verwalter_diktatzeichen, verwalter_geschlecht, ... }
Response: {
  templateType: "natuerliche_person",
  slots: GutachtenSlot[],
  feldValues: Record<string, string>  // FELD_*-Werte zur Anzeige
}
```

**Generate (DOCX erstellen):**
```
POST /api/generate-gutachten/:extractionId/generate
Body: {
  userInputs: GutachtenUserInputs,
  slots: { id: string, value: string }[]  // finale Slot-Werte vom Nutzer
}
Response: DOCX-Datei als Download
```

Das Frontend (`GutachtenDialog.tsx`) wird entsprechend auf die neuen Endpoints umgestellt.

### XML-Escaping (PFLICHT)

**`applySlots` MUSS `escapeXml()` auf jeden Slot-Wert anwenden** bevor er in den XML-Text eingefügt wird. Nutzer-Eingaben wie `Müller & Söhne` oder `<Firma>` würden sonst invalides XML erzeugen und die DOCX-Datei korrumpieren. Die existierende `escapeXml()`-Funktion in `gutachtenGenerator.ts` wird wiederverwendet.

### Dateien

**Neu:** `backend/src/utils/gutachtenSlotFiller.ts`
- `extractSlots(xml: string): { xml: string, slots: SlotInfo[] }` — Slot-Extraktion (nutzt Paragraph-Flattening)
- `fillSlots(slots: SlotInfo[], result: ExtractionResult): Promise<GutachtenSlot[]>` — KI-Befüllung
- `applySlots(xml: string, slots: { id: string, value: string }[]): string` — Finale Ersetzung (nutzt Paragraph-Flattening + escapeXml)

**Refactor:** `backend/src/utils/gutachtenGenerator.ts`
- `processDocxParagraphs(xml, transformFn)` — Gemeinsame Paragraph-Flattening-Hilfsfunktion
- `generateGutachten()` entfernt (alter Single-Step-Flow)
- Neuer Export: `prepareGutachten()` für den prepare-Endpoint
- Neuer Export: `generateGutachtenFinal()` nimmt fertige Slot-Werte entgegen

**Ändern:** `backend/src/routes/generateGutachten.ts`
- Alter `POST /:extractionId` entfernt
- Neuer `POST /:extractionId/prepare` — gibt Slots als JSON zurück
- Neuer `POST /:extractionId/generate` — erstellt DOCX mit finalen Slot-Werten

**Ändern:** `frontend/src/components/extraction/GutachtenDialog.tsx`
- Wird zum mehrstufigen Wizard:
  1. Schritt: Verwalter-Daten eingeben
  2. Schritt: Slot-Vorschau reviewen + editieren (nach prepare-Call)
  3. Schritt: Bestätigen + Download (generate-Call)

### Frontend Slot-Editor

Im Dialog-Schritt 2 werden die Slots tabellarisch angezeigt:

| # | Kontext | Vorschlag | Status |
|---|---------|-----------|--------|
| 1 | "Antrag vom [[SLOT_001]]" | 18.12.2025 | filled |
| 2 | "beschäftigt [[SLOT_002]] Arbeitnehmer" | 47 | filled |
| 3 | "[TODO: Lohnrückstände angeben]" | — | todo |

- `filled`: Grüner Rahmen, editierbares Textfeld
- `todo`: Gelber Rahmen, editierbares Textfeld mit Hinweis
- `editorial`: Grauer Rahmen, nicht editierbar (bleibt als Anweisung im DOCX)

Der Nutzer kann jeden `filled`/`todo`-Wert überschreiben.

### Nicht im Scope

- Tabellen-Generierung (`[Tabelle]` → bleibt als `[TODO: Tabelle einfügen]`)
- Externe Daten-Integration (North Data, Statista)
- Automatische er/sie-Anpassung im Fließtext (nur in FELD_*-Computed-Fields)
