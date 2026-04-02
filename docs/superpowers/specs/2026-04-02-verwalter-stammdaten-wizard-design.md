# Verwalter-Stammdaten + Gutachten Wizard

## Overview

Replace the flat GutachtenDialog with a 4-step wizard and persist Verwalter profiles so lawyers don't re-enter their details every time. The firm has 6-7 Verwalter (partners/associates) whose data rarely changes.

## Database

New table `verwalter_profiles` in existing SQLite DB:

```sql
CREATE TABLE verwalter_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  titel TEXT DEFAULT '',
  geschlecht TEXT NOT NULL DEFAULT 'maennlich',
  diktatzeichen TEXT DEFAULT '',
  sachbearbeiter_name TEXT DEFAULT '',
  sachbearbeiter_email TEXT DEFAULT '',
  sachbearbeiter_durchwahl TEXT DEFAULT '',
  standort TEXT DEFAULT '',
  anderkonto_iban TEXT DEFAULT '',
  anderkonto_bank TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Added via migration file `backend/src/db/migrations/NNN_add_verwalter_profiles.sql`. No foreign keys to other tables — Verwalter profiles are standalone reference data.

## API

All endpoints require authentication (existing JWT middleware). No role restriction — any logged-in user can manage profiles.

### Endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/verwalter` | — | `VerwalterProfile[]` |
| `POST` | `/api/verwalter` | `Omit<VerwalterProfile, 'id'>` | `VerwalterProfile` |
| `PUT` | `/api/verwalter/:id` | `Partial<VerwalterProfile>` | `VerwalterProfile` |
| `DELETE` | `/api/verwalter/:id` | — | `{ ok: true }` |

### Type

```typescript
interface VerwalterProfile {
  id: number;
  name: string;           // "RA Dr. Alexander Lamberty LL.M."
  titel: string;          // "Fachanwalt für Insolvenz- und Sanierungsrecht"
  geschlecht: 'maennlich' | 'weiblich';
  diktatzeichen: string;  // "La/Bi"
  sachbearbeiter_name: string;    // "Christoph Orthen LL.M."
  sachbearbeiter_email: string;   // "Christoph.Orthen@tbs-insolvenzverwalter.de"
  sachbearbeiter_durchwahl: string; // "0651 / 170 830 - 124"
  standort: string;       // "Zell/Mosel"
  anderkonto_iban: string; // Default Anderkonto for this Verwalter
  anderkonto_bank: string; // "Sparkasse Trier"
}
```

## Frontend

### VerwalterManager

A modal/dialog accessible from the Gutachten tab or a settings icon. Simple CRUD list:
- Table of existing Verwalter with edit/delete buttons
- "Neuer Verwalter" button → inline form
- Fields match the `VerwalterProfile` type
- No complex validation — just name is required

### GutachtenWizard (replaces GutachtenDialog)

4-step wizard component. Same props as current `GutachtenDialog`:
```typescript
interface GutachtenWizardProps {
  result: ExtractionResult;
  extractionId: number;
  onClose: () => void;
}
```

#### Step 1: Verwalter auswählen
- Dropdown of saved Verwalter profiles (fetched from `/api/verwalter`)
- On selection: auto-fills all Verwalter fields (name, geschlecht, diktatzeichen, sachbearbeiter, standort, anderkonto)
- Displays auto-filled values as read-only cards
- "Verwalter verwalten" link to open VerwalterManager

#### Step 2: Schuldner & Verfahren prüfen
- Pre-filled from `result` (extraction data)
- Displays key fields in a 2-column grid: Name, Vorname, Geburtsdatum, Familienstand, Firma, Rechtsform, Betriebsstätte, Gericht, Aktenzeichen, Beschlussdatum, Antragsart
- Entity-aware: shows corporate fields (GF, HRB) for juristische Person, personal fields (Geburtsdatum, Familienstand) for natürliche Person
- Missing fields highlighted with maroon border + ⚠ icon, inline-editable
- Edits update the extraction result via existing `onUpdateField` mechanism
- Banner at top: "⚠ X Felder fehlen — bitte ergänzen" (or "Alle Pflichtfelder vorhanden ✓")

#### Step 3: Fehlende Angaben
- Shows ONLY fields that are:
  - Required for the Gutachten template
  - Not filled by extraction OR Verwalter profile
- Typically: Anderkonto (if not set on Verwalter profile), Geschäftsführer (for jur. Person)
- If all fields are covered: shows "Alle Angaben vorhanden" with green checkmark
- Each field is an input with label and optional hint

#### Step 4: Vorschau & Generieren
- Stats cards: KI-Felder gefüllt / Slots für KI-Text / TODO (manuell)
- Template type display (natürliche Person / juristische Person / Personengesellschaft)
- "GUTACHTEN GENERIEREN" button
- Calls existing `POST /api/gutachten/:id/prepare` then `POST /api/gutachten/:id/generate`
- Shows loading state during AI slot filling
- On completion: triggers DOCX download

### Navigation
- Step indicators at top (1-2-3-4 with current highlighted)
- "Zurück" / "Weiter" buttons
- "Weiter" disabled if required fields in current step are missing
- Can navigate back freely

## What stays unchanged

- Backend Gutachten pipeline (`prepareGutachten`, `generateGutachtenFinal`, slot filling)
- Template files and KI_* mapping
- The wizard assembles the same `GutachtenUserInputs` object that the current dialog produces
- Extraction result editing (uses existing `onUpdateField` / field update API)

## File changes

### New files
- `backend/src/db/migrations/003_add_verwalter_profiles.sql`
- `backend/src/routes/verwalter.ts`
- `frontend/src/components/extraction/GutachtenWizard.tsx`
- `frontend/src/components/extraction/VerwalterManager.tsx`
- `frontend/src/hooks/useVerwalter.ts`

### Modified files
- `backend/src/index.ts` — register verwalter routes
- `frontend/src/components/extraction/tabs/GutachtenTab.tsx` — replace GutachtenDialog with GutachtenWizard
- `frontend/src/types/extraction.ts` — export VerwalterProfile type

### Deleted files
- `frontend/src/components/extraction/GutachtenDialog.tsx` — replaced by GutachtenWizard
