# Standardschreiben-Generierung aus der UI

## Ziel

Aus einer abgeschlossenen Extraktion heraus die 10 Standardschreiben als DOCX
generieren und herunterladen. Alle `FELD_*`-Platzhalter werden mit den
extrahierten Daten gefüllt; fehlende Felder kann der User vor der Generierung
inline ergänzen. Administratoren können die DOCX-Vorlagen selbst hochladen /
austauschen, genauso wie bei den Gutachten-Vorlagen.

## Status Quo (vorgefunden, teilweise kaputt)

- `backend/src/routes/generateLetter.ts` existiert, referenziert aber
  `checkItem.templatePdf` aus `checklisten.json` — dieses Feld wurde in
  Commit `4301103` entfernt. **Route ist aktuell nicht funktionsfähig.**
- `backend/src/utils/docxGenerator.ts` nutzt `docxtemplater` und erwartet
  `{FELD_*}`-Syntax mit geschweiften Klammern. Die neuen Templates haben
  `FELD_*` ohne Klammern (analog zu `KI_*` bei Gutachten).
- `standardschreiben/checklisten.json` enthält `requiredFields` /
  `requiredFieldsOr` für die 10 Typen, aber keinen Template-Pfad mehr.
- `frontend/.../AnschreibenTab.tsx` zeigt Status-Karten (bereit / fehlt /
  entfaellt) und eine `FieldChecklist` zum Nachtragen — aber **keinen
  Generieren-Button**.
- `standardschreiben/templates/*.docx` — **10 Templates bereits erstellt** (via
  Claude Vision Pipeline) und manuell abgenommen, mit vollständig
  normalisierten Platzhaltern. (Aktueller Stand, außerhalb dieses Specs.)

## Architektur

```
standardschreiben/
  templates/                    ← 10 .docx (fertig, abgenommen)
  platzhalter-mapping.json      ← NEU: alle FELD_* → Quelle (path/computed/kanzlei/verwalter/input)
  checklisten.json              ← erweitert um templateDocx-Feld

backend/src/
  routes/
    generateLetter.ts           ← FIX: liest templateDocx aus checklisten.json,
                                  nimmt zusätzlich UI-Inputs für Strafakte entgegen
    letterTemplates.ts          ← NEU: GET/PUT/rollback /api/letter-templates/:typ
  utils/
    docxGenerator.ts            ← REWRITE: XML-Text-Replacement analog
                                  gutachtenGenerator.ts (robust gegen Word-Run-Splitting)

frontend/src/
  components/extraction/tabs/
    AnschreibenTab.tsx          ← erweitert: "DOCX erzeugen"-Button pro Brief,
                                  Modal für Strafverfahren-Inputs
  pages/AdminPage.tsx           ← erweitert: Abschnitt "Standardschreiben-Vorlagen"
                                  mit Download/Upload/Rollback pro Brieftyp
```

## Platzhalter-Katalog

Gesamter Catalog (29 Felder), entnommen aus den 10 konvertierten DOCX:

| Platzhalter | Quelle / Berechnung |
|---|---|
| `FELD_Akte_Aktenzeichen` | `verfahrensdaten.aktenzeichen.wert` |
| `FELD_Akte_Gericht` | `verfahrensdaten.gericht.wert` |
| `FELD_Akte_LastGAVV` | `verfahrensdaten.beschlussdatum.wert` (TBS-Konvention; `GAW`-Variante wird beim Upload auf `GAVV` normalisiert) |
| `FELD_Akte_EroeffDat` | `verfahrensdaten.eroeffnungsdatum.wert`, Fallback `beschlussdatum` |
| `FELD_Akte_Bezeichnung` | computed: Aktenzeichen + Verfahrensart |
| `FELD_Akte_VerfahrenArt` | computed: "Insolvenzantragsverfahren" / "Insolvenzverfahren" |
| `FELD_Gericht_Ort` | computed: Stadt aus `verfahrensdaten.gericht` |
| `FELD_Schuldner_Name` | `schuldner.name.wert` |
| `FELD_Schuldner_Vorname` | `schuldner.vorname.wert` |
| `FELD_Schuldner_Vollname` | computed: "Vorname Name" oder `firma` |
| `FELD_Schuldner_Adr` | `schuldner.aktuelle_adresse.wert` |
| `FELD_Schuldner_Firma` | `schuldner.firma.wert` |
| `FELD_Schuldner_Betriebsstaette` | `schuldner.betriebsstaette_adresse.wert` |
| `FELD_Schuldner_HRB` | `schuldner.handelsregisternummer.wert` |
| `FELD_Schuldner_Artikel` / `_der_die` | computed gender: der/die (Nominativ) |
| `FELD_Schuldner_Der_Die_Groß` | computed gender: Der/Die |
| `FELD_Schuldner_den_die` | computed gender: den/die (Akkusativ) |
| `FELD_Schuldner_dem_der` | computed gender: dem/der (Dativ) |
| `FELD_Schuldner_Schuldnerin` | computed gender: Schuldner/Schuldnerin (Nominativ) |
| `FELD_Schuldners_Schuldnerin` | computed gender: Schuldners/Schuldnerin (Genitiv) |
| `FELD_Schuldner_Halters_Halterin` | computed gender: des Halters / der Halterin |
| `FELD_Verwalter_Name` | aus `verwalter_profiles` via `extractions.verwalter_id` |
| `FELD_Verwalter_Art` | aus Bestellungsbeschluss oder Verwalter-Profil |
| `FELD_Verwalter_Unterzeichner` | Alias von `Verwalter_Name` |
| `FELD_Verwalter_Diktatzeichen` | computed: Initialen |
| `FELD_Verwalter_der_die` / `_Der_Die_Groß` / `_zum_zur` | computed gender verwalter |
| `FELD_Bet_AnredeHoeflichOV` | static: "Sehr geehrte Damen und Herren," |
| `FELD_Bet_GrussBriefende` | static: "Mit freundlichen Grüßen" |
| `FELD_ANSCHREIBEN_DAT_2` | computed: Antwort-Frist (heute + X Werktage) oder user-input |
| `FELD_Strafverfahren_Person` | user-input (UI-Feld beim Generieren) |
| `FELD_Strafverfahren_Tatvorwurf` | user-input |
| `FELD_Strafverfahren_Gegenstand` | user-input |

## `platzhalter-mapping.json` (neu)

Analog zu `gutachten-mapping.json`, plus Quelle `input` für Strafverfahren-Felder:

```json
{
  "_version": "2.0",
  "felder": {
    "FELD_Akte_Aktenzeichen":    { "path": "verfahrensdaten.aktenzeichen.wert" },
    "FELD_Akte_LastGAVV":        { "path": "verfahrensdaten.beschlussdatum.wert" },
    "FELD_Schuldner_dem_der":    { "computed": "schuldner_geschlecht_dem_der" },
    "FELD_Schuldner_Halters_Halterin": { "computed": "schuldner_geschlecht_halters_halterin" },
    "FELD_Verwalter_Name":       { "verwalter": "name" },
    "FELD_Bet_GrussBriefende":   { "static": "Mit freundlichen Grüßen" },
    "FELD_Strafverfahren_Person": { "input": "strafverfahren_person", "required_for": ["Strafakte-Akteneinsicht"] },
    ...
  }
}
```

## Backend

### `docxGenerator.ts` Rewrite

Ersetze docxtemplater durch XML-Text-Replacement wie in `gutachtenGenerator.ts`:

- Öffne DOCX als PizZip, extrahiere `word/document.xml`.
- `processDocxParagraphs`: für jeden Paragraph alle `<w:t>`-Inhalte
  flachen (merge to first run), dann Regex-Replace jedes `FELD_*`-Tokens.
- Preserved: Absatz-Alignment (Blocksatz für Fließtext, LEFT für Gruß/Anlagen),
  Unterstreichungen, Soft-Breaks in der Signatur.
- Input: `ExtractionResult` + `verwalter_id` + `extras` (für `FELD_Strafverfahren_*`).

### `generateLetter.ts` Fix

- `POST /api/generate-letter/:extractionId/:typ` — Body kann `extras: Record<string, string>`
  enthalten (z.B. für Strafakte).
- Lies `templateDocx` aus erweitertem `checklisten.json` (neues Feld).
- Status-Check bleibt: nur wenn `status === 'bereit'` wird generiert.
- Verwalter-Profil wird via `extractions.verwalter_id` gezogen (wie Gutachten).

### `letterTemplates.ts` (neu)

Analog zu `kanzlei.ts` Template-Endpoints:

- `GET  /api/letter-templates/:typ` → DOCX-Download
- `PUT  /api/letter-templates/:typ` → Upload (admin-only, Validierung der
  benötigten `FELD_*`-Platzhalter, Backup mit `.backup.docx` anlegen)
- `POST /api/letter-templates/:typ/rollback` → aus `.backup.docx`
  wiederherstellen

Validierung beim Upload: extractPlaceholders auf der hochgeladenen DOCX,
abgleichen gegen `checklisten.json`-Pflichtliste pro Typ. Fehlende Felder → 400.

### Checklisten-Erweiterung

`standardschreiben/checklisten.json` bekommt pro Eintrag:

```json
{
  "typ": "Bankenauskunft",
  "templateDocx": "templates/Bankenanfrage.docx",
  ...
}
```

## Frontend

### AnschreibenTab erweitert

Pro Brief mit `status === 'bereit'`: Button "📄 DOCX erzeugen".

Click → `POST /api/generate-letter/:id/:typ` → DOCX-Download.

**Strafakte-Sonderfall**: Click öffnet ein Modal mit 3 Textfeldern
(Person, Tatvorwurf, Gegenstand). Nach Bestätigung Request mit `extras`.

Für `fehlt`-Status: Button deaktiviert, FieldChecklist bleibt zum Nachtragen.
`onUpdateField` persistiert via existierendem PATCH-Endpoint und triggert
`validateLettersAgainstChecklists` → Status kann von `fehlt` auf `bereit`
wechseln.

### AdminPage: Neuer Abschnitt "Standardschreiben-Vorlagen"

Tabelle mit 10 Zeilen (ein Eintrag pro Brieftyp):

| Brieftyp | Stand | Aktionen |
|---|---|---|
| Bankenauskunft | `Bankenanfrage.docx` (vor 3d geändert) | Download · Upload · Rollback |
| ... | ... | ... |

Upload-Validierung zeigt fehlende Pflicht-Platzhalter als Fehlermeldung.

## Nicht im Scope

- **Freitext-Edit pro Generierung** (Option A aus Brainstorming) — User editiert
  das DOCX nach Download in Word.
- **Generate-all als ZIP** — einzelne Downloads reichen.
- **Versionierung** — nur `.backup.docx` (eine Rückfalloption).
- **AI-Auto-Fill für Freitext-Felder** (Strafverfahren-Inputs) — User muss
  das selbst eingeben.
- **i18n** — alles deutsch, wie Rest der App.

## Testplan

- Unit: `docxGenerator` mit Mock-ExtractionResult + Mock-Template,
  prüft alle Platzhalter-Ersetzungen inkl. gender-computed.
- Integration: `POST /api/generate-letter/:id/Bankenauskunft` → DOCX öffnen,
  prüfen dass Aktenzeichen, Beschlussdatum, Schuldnername, Verwaltername ersetzt sind.
- Manuell: komplette Extraktion eines Muster-PDF (Geldt), alle 10 Briefe
  generieren, in Word öffnen, visuell prüfen.
- Upload-Flow: gültiges DOCX hochladen → Backup wird erstellt. Ungültiges
  DOCX (fehlende Pflicht-Platzhalter) → 400 mit sinnvoller Meldung.
