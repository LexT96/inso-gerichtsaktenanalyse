# Prüfliste-Tab Design

## Zusammenfassung

Neuer Tab "Prüfliste" zur manuellen Bestätigung, Korrektur und Ergänzung der 9 Felder, die für die Standardanschreiben benötigt werden. Änderungen werden in der DB persistiert und aktualisieren die Briefstatus live.

## Felder

Aus `standardschreiben/checklisten.json` abgeleitet — 9 einzigartige Felder:

### Verfahrensdaten (2)
- `verfahrensdaten.aktenzeichen`
- `verfahrensdaten.gericht`

### Schuldner — Person (5)
- `schuldner.name`
- `schuldner.vorname`
- `schuldner.geburtsdatum`
- `schuldner.aktuelle_adresse`
- `schuldner.handelsregisternummer`

### Schuldner — Firma (2)
- `schuldner.firma`
- `schuldner.betriebsstaette_adresse`

## Tab-Position & Badge

- Position 6 (nach Ermittlung, vor Anschreiben)
- Icon: `✓`
- Badge: Anzahl unbestätigter Felder (die einen Wert haben aber nicht bestätigt sind)

## Layout

- Fortschrittsanzeige oben: "X von Y bestätigt"
- 3 collapsible Sections (Verfahrensdaten, Schuldner Person, Schuldner Firma)
- Pro Feld eine Zeile: Label | Wert (editierbar) | Status-Icon | Bestätigen-Button

## Interaktion

### Bestätigen
- Klick auf Häkchen-Button → `pruefstatus: 'bestaetigt'`
- Grünes ✓ anzeigen

### Korrigieren
- Klick auf Wert → Inline-Textfeld
- Enter speichert, Escape bricht ab
- Setzt `pruefstatus: 'korrigiert'` (implizit bestätigt)

### Manuell eintragen
- Bei leeren Feldern: "Eintragen"-Link
- Öffnet Inline-Textfeld
- Setzt `pruefstatus: 'manuell'`

## Datenmodell

Neues optionales Feld auf `SourcedValue`:

```typescript
interface SourcedValue<T = string> {
  wert: T | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: 'bestaetigt' | 'korrigiert' | 'manuell';
}
```

## Backend API

### PATCH `/api/extractions/:id/fields`

```json
{
  "fieldPath": "schuldner.name",
  "wert": "Müller",
  "pruefstatus": "korrigiert"
}
```

- Aktualisiert das Feld im gespeicherten JSON
- Gibt den aktualisierten SourcedValue zurück
- Validiert fieldPath gegen Whitelist der 9 erlaubten Felder

## Frontend: Live-Update der Briefstatus

- Checklist-Logik aus `letterChecklist.ts` wird als Frontend-Utility portiert
- Nur die "hat Feld einen Wert?"-Prüfung, keine Datei-I/O
- `checklisten.json` wird als statischer Import eingebunden
- Nach jeder Änderung wird `ExtractionResult`-State im `useExtraction`-Hook aktualisiert
- Alle Tabs (inkl. Anschreiben-Tab Badges) reagieren sofort

## Dateien

### Neu
- `frontend/src/components/extraction/tabs/PrueflisteTab.tsx` — Tab-Komponente
- `frontend/src/utils/checklistValidator.ts` — Frontend-Checklist-Logik
- `backend/src/routes/fieldUpdate.ts` — PATCH-Endpoint

### Modifiziert
- `shared/types/extraction.ts` — `pruefstatus` Feld hinzufügen
- `frontend/src/pages/DashboardPage.tsx` — Tab registrieren
- `frontend/src/hooks/useExtraction.ts` — `updateField()` Methode hinzufügen
- `backend/src/index.ts` — Route registrieren
