# Prüfliste Tab Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Prüfliste" tab where users can see, confirm, correct, and manually enter the 9 fields needed for standard letters, with backend persistence and live letter status updates.

**Architecture:** New tab component reads fields from ExtractionResult, allows inline editing, persists changes via PATCH API to backend (updates result_json in SQLite), and recomputes letter status client-side using ported checklist logic.

**Tech Stack:** React, TypeScript, Tailwind CSS, Express, better-sqlite3

---

## File Structure

### New Files
| File | Responsibility |
|------|----------------|
| `frontend/src/components/extraction/tabs/PrueflisteTab.tsx` | Tab component: renders 3 sections with 9 editable fields, progress bar, confirm/edit interactions |
| `frontend/src/utils/checklistValidator.ts` | Frontend port of letter checklist logic: given an ExtractionResult, recomputes which letters are bereit/fehlt |
| `backend/src/routes/fieldUpdate.ts` | PATCH `/api/extractions/:id/fields` endpoint: validates field path, updates result_json in DB |

### Modified Files
| File | Change |
|------|--------|
| `shared/types/extraction.ts` | Add `pruefstatus` to SourcedValue, SourcedNumber, SourcedBoolean |
| `frontend/src/hooks/useExtraction.ts` | Add `updateField()` method that patches local state + calls API |
| `frontend/src/pages/DashboardPage.tsx` | Register Prüfliste tab (position 6), pass props, compute badge |
| `backend/src/index.ts` | Register fieldUpdate route |

---

## Chunk 1: Shared Types + Backend API

### Task 1: Add `pruefstatus` to shared types

**Files:**
- Modify: `shared/types/extraction.ts:1-17`

- [ ] **Step 1: Add pruefstatus type and field**

Add the type alias and the field to all three sourced interfaces:

```typescript
// After line 0 (top of file)
export type Pruefstatus = 'bestaetigt' | 'korrigiert' | 'manuell';

// In SourcedValue (line 4):
export interface SourcedValue<T = string> {
  wert: T | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: Pruefstatus;
}

// In SourcedNumber (line 10):
export interface SourcedNumber {
  wert: number | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: Pruefstatus;
}

// In SourcedBoolean (line 15):
export interface SourcedBoolean {
  wert: boolean | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: Pruefstatus;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors (pruefstatus is optional, so existing code is unaffected)

- [ ] **Step 3: Commit**

```bash
git add shared/types/extraction.ts
git commit -m "feat: add pruefstatus field to SourcedValue types"
```

---

### Task 2: Backend PATCH endpoint for field updates

**Files:**
- Create: `backend/src/routes/fieldUpdate.ts`
- Modify: `backend/src/index.ts:10-29`

- [ ] **Step 1: Create the field update route**

Create `backend/src/routes/fieldUpdate.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import type { Pruefstatus } from '../../shared/types/extraction';

const router = Router();

/**
 * Whitelist of field paths that can be updated via this endpoint.
 * These are the 9 fields required by the standard letters.
 */
const ALLOWED_FIELDS = new Set([
  'verfahrensdaten.aktenzeichen',
  'verfahrensdaten.gericht',
  'schuldner.name',
  'schuldner.vorname',
  'schuldner.geburtsdatum',
  'schuldner.aktuelle_adresse',
  'schuldner.handelsregisternummer',
  'schuldner.firma',
  'schuldner.betriebsstaette_adresse',
]);

const VALID_PRUEFSTATUS = new Set<Pruefstatus>(['bestaetigt', 'korrigiert', 'manuell']);

router.patch('/:id/fields', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const id = parseInt(req.params['id'] ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const { fieldPath, wert, pruefstatus } = req.body as {
    fieldPath: string;
    wert: string | null;
    pruefstatus: Pruefstatus;
  };

  // Validate fieldPath
  if (!fieldPath || !ALLOWED_FIELDS.has(fieldPath)) {
    res.status(400).json({ error: `Ungültiger Feldpfad: ${fieldPath}` });
    return;
  }

  // Validate pruefstatus
  if (!pruefstatus || !VALID_PRUEFSTATUS.has(pruefstatus)) {
    res.status(400).json({ error: `Ungültiger Prüfstatus: ${pruefstatus}` });
    return;
  }

  // Load extraction
  const row = db.prepare(
    'SELECT result_json FROM extractions WHERE id = ? AND user_id = ?'
  ).get(id, userId) as { result_json: string | null } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  if (!row.result_json) {
    res.status(400).json({ error: 'Extraktion hat kein Ergebnis' });
    return;
  }

  // Parse and update the field
  const result = JSON.parse(row.result_json);
  const parts = fieldPath.split('.');

  // Navigate to parent object (e.g., "schuldner")
  let obj = result;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]];
    if (!obj) {
      res.status(400).json({ error: `Pfad nicht gefunden: ${fieldPath}` });
      return;
    }
  }

  // Update the leaf field (e.g., "name")
  const leafKey = parts[parts.length - 1];
  const field = obj[leafKey];

  if (!field || typeof field !== 'object') {
    res.status(400).json({ error: `Feld nicht gefunden: ${fieldPath}` });
    return;
  }

  field.wert = wert;
  field.pruefstatus = pruefstatus;

  // Save back to DB
  db.prepare(
    'UPDATE extractions SET result_json = ? WHERE id = ? AND user_id = ?'
  ).run(JSON.stringify(result), id, userId);

  res.json({ ok: true, field: { wert: field.wert, quelle: field.quelle, verifiziert: field.verifiziert, pruefstatus: field.pruefstatus } });
});

export default router;
```

- [ ] **Step 2: Register the route in index.ts**

In `backend/src/index.ts`, add after line 12 (generateLetter import):

```typescript
import fieldUpdateRoutes from './routes/fieldUpdate';
```

Add after line 29 (generate-letter route):

```typescript
app.use('/api/extractions', fieldUpdateRoutes);
```

- [ ] **Step 3: Verify backend compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/fieldUpdate.ts backend/src/index.ts
git commit -m "feat: add PATCH endpoint for field updates"
```

---

## Chunk 2: Frontend Checklist Validator + Hook

### Task 3: Port checklist validation to frontend

**Files:**
- Create: `frontend/src/utils/checklistValidator.ts`

- [ ] **Step 1: Create the checklist validator**

This mirrors the backend `letterChecklist.ts` logic but runs client-side using a static copy of the checklist config.

Create `frontend/src/utils/checklistValidator.ts`:

```typescript
import type { ExtractionResult, Standardanschreiben } from '../types/extraction';

interface ChecklistRule {
  typ: string;
  requiredFields: string[];
  requiredFieldsOr?: string[][];
}

/**
 * Static checklist rules derived from standardschreiben/checklisten.json.
 * Only the fields needed for status computation (typ, requiredFields, requiredFieldsOr).
 */
const CHECKLIST_RULES: ChecklistRule[] = [
  {
    typ: 'Bankenauskunft',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Bausparkassen-Anfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Steuerberater-Kontakt',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname'],
      ['schuldner.firma'],
    ],
  },
  {
    typ: 'Strafakte-Akteneinsicht',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'KFZ-Halteranfrage Zulassungsstelle',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.geburtsdatum', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.handelsregisternummer', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Gewerbeauskunft',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.betriebsstaette_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Finanzamt-Anfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'KFZ-Halteranfrage KBA',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.geburtsdatum', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.handelsregisternummer', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Versicherungsanfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Gerichtsvollzieher-Anfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
];

function getFieldValue(result: ExtractionResult, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return undefined;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj != null && typeof obj === 'object' && 'wert' in (obj as object)) {
    return (obj as { wert: unknown }).wert;
  }
  return obj;
}

function hasValue(result: ExtractionResult, fieldPath: string): boolean {
  const v = getFieldValue(result, fieldPath);
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return !Number.isNaN(v);
  return true;
}

function isRuleSatisfied(result: ExtractionResult, rule: ChecklistRule): boolean {
  for (const field of rule.requiredFields) {
    if (!hasValue(result, field)) return false;
  }
  if (rule.requiredFieldsOr && rule.requiredFieldsOr.length > 0) {
    return rule.requiredFieldsOr.some(group =>
      group.every(field => hasValue(result, field))
    );
  }
  return true;
}

/**
 * Recomputes letter statuses based on current ExtractionResult field values.
 * Returns a new standardanschreiben array with updated statuses.
 * Letters with status 'entfaellt' are not changed.
 */
export function recomputeLetterStatuses(result: ExtractionResult): Standardanschreiben[] {
  const letters = result.standardanschreiben || [];

  return letters.map(letter => {
    // Don't change 'entfaellt' status
    if (letter.status === 'entfaellt') return letter;

    const rule = CHECKLIST_RULES.find(r => r.typ === letter.typ);
    if (!rule) return letter;

    const satisfied = isRuleSatisfied(result, rule);

    if (satisfied && letter.status === 'fehlt') {
      return { ...letter, status: 'bereit' as const, fehlende_daten: [] };
    }
    if (!satisfied && letter.status === 'bereit') {
      return { ...letter, status: 'fehlt' as const };
    }

    return letter;
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils/checklistValidator.ts
git commit -m "feat: add frontend checklist validator for live letter status updates"
```

---

### Task 4: Add `updateField` to useExtraction hook

**Files:**
- Modify: `frontend/src/hooks/useExtraction.ts`

- [ ] **Step 1: Add updateField method**

Import the recompute function at the top of the file (after line 3):

```typescript
import { recomputeLetterStatuses } from '../utils/checklistValidator';
import type { Pruefstatus } from '../types/extraction';
```

Add the `updateField` function after `loadDemo` (before the return statement, around line 206):

```typescript
const updateField = useCallback(async (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => {
  if (!state.result) return;

  // Optimistic local update
  const updatedResult = structuredClone(state.result);
  const parts = fieldPath.split('.');
  let obj: Record<string, unknown> = updatedResult as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  const leafKey = parts[parts.length - 1];
  const field = obj[leafKey] as { wert: unknown; quelle: string; verifiziert?: boolean; pruefstatus?: string };
  field.wert = wert;
  field.pruefstatus = pruefstatus;

  // Recompute letter statuses
  updatedResult.standardanschreiben = recomputeLetterStatuses(updatedResult);

  setState(s => ({ ...s, result: updatedResult }));

  // Persist to backend (fire-and-forget for demo mode, await for real extractions)
  if (state.extractionId) {
    try {
      await apiClient.patch(`/extractions/${state.extractionId}/fields`, {
        fieldPath,
        wert,
        pruefstatus,
      });
    } catch (err) {
      console.error('Failed to persist field update:', err);
    }
  }
}, [state.result, state.extractionId]);
```

Update the return statement (line 207) to include `updateField`:

```typescript
return { ...state, extract, reset, loadDemo, loadFromHistory, updateField };
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useExtraction.ts
git commit -m "feat: add updateField method to useExtraction hook"
```

---

## Chunk 3: Prüfliste Tab Component + Dashboard Integration

### Task 5: Create PrueflisteTab component

**Files:**
- Create: `frontend/src/components/extraction/tabs/PrueflisteTab.tsx`

- [ ] **Step 1: Create the tab component**

Create `frontend/src/components/extraction/tabs/PrueflisteTab.tsx`:

```tsx
import { useState } from 'react';
import { Section } from '../Section';
import type { ExtractionResult, SourcedValue, Pruefstatus } from '../../../types/extraction';

interface PrueflisteTabProps {
  result: ExtractionResult;
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}

interface FieldDef {
  path: string;
  label: string;
}

const VERFAHRENSDATEN_FIELDS: FieldDef[] = [
  { path: 'verfahrensdaten.aktenzeichen', label: 'Aktenzeichen' },
  { path: 'verfahrensdaten.gericht', label: 'Gericht' },
];

const SCHULDNER_PERSON_FIELDS: FieldDef[] = [
  { path: 'schuldner.name', label: 'Name' },
  { path: 'schuldner.vorname', label: 'Vorname' },
  { path: 'schuldner.geburtsdatum', label: 'Geburtsdatum' },
  { path: 'schuldner.aktuelle_adresse', label: 'Aktuelle Adresse' },
  { path: 'schuldner.handelsregisternummer', label: 'Handelsregister-Nr.' },
];

const SCHULDNER_FIRMA_FIELDS: FieldDef[] = [
  { path: 'schuldner.firma', label: 'Firma' },
  { path: 'schuldner.betriebsstaette_adresse', label: 'Betriebsstätte-Adresse' },
];

function getField(result: ExtractionResult, path: string): SourcedValue | null {
  const parts = path.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj && typeof obj === 'object' && 'quelle' in (obj as object)) {
    return obj as SourcedValue;
  }
  return null;
}

function fieldHasValue(field: SourcedValue | null): boolean {
  if (!field) return false;
  const w = field.wert;
  return w !== null && w !== undefined && String(w).trim() !== '';
}

interface CheckFieldRowProps {
  def: FieldDef;
  result: ExtractionResult;
  onUpdate: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}

function CheckFieldRow({ def, result, onUpdate }: CheckFieldRowProps) {
  const field = getField(result, def.path);
  const hasVal = fieldHasValue(field);
  const wert = hasVal ? String(field!.wert) : '';
  const pruefstatus = field?.pruefstatus;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEdit = () => {
    setEditValue(wert);
    setEditing(true);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed === '') {
      setEditing(false);
      return;
    }
    const status: Pruefstatus = hasVal ? 'korrigiert' : 'manuell';
    onUpdate(def.path, trimmed, status);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const handleConfirm = () => {
    if (hasVal) {
      onUpdate(def.path, String(field!.wert), 'bestaetigt');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  // Status icon
  const statusIcon = pruefstatus === 'bestaetigt' ? '\u2713'
    : pruefstatus === 'korrigiert' ? '\u270e'
    : pruefstatus === 'manuell' ? '+'
    : null;

  const statusColor = pruefstatus === 'bestaetigt' ? 'text-ie-green'
    : pruefstatus === 'korrigiert' ? 'text-ie-blue'
    : pruefstatus === 'manuell' ? 'text-ie-blue'
    : 'text-text-muted';

  return (
    <div className="flex items-center py-2 border-b border-border gap-2">
      {/* Status icon */}
      <span className={`w-5 text-center text-xs font-bold ${statusColor}`}>
        {statusIcon ?? '\u25cb'}
      </span>

      {/* Label */}
      <span className="flex-shrink-0 w-[160px] text-[11px] text-text-dim">{def.label}</span>

      {/* Value */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveEdit}
            autoFocus
            className="w-full bg-bg border border-accent rounded-sm px-2 py-1 text-xs font-mono text-text outline-none"
          />
        ) : hasVal ? (
          <button
            onClick={startEdit}
            className="text-xs font-mono text-text hover:text-accent cursor-pointer bg-transparent border-none text-left transition-colors"
            title="Klicken zum Bearbeiten"
          >
            {wert}
          </button>
        ) : (
          <button
            onClick={startEdit}
            className="text-[10px] text-ie-amber hover:text-accent cursor-pointer bg-transparent border-none transition-colors"
          >
            Eintragen...
          </button>
        )}
      </div>

      {/* Confirm button */}
      {hasVal && !pruefstatus && (
        <button
          onClick={handleConfirm}
          title="Wert bestätigen"
          className="px-2 py-0.5 border border-border rounded-sm bg-transparent text-text-muted text-[10px] cursor-pointer font-mono hover:border-ie-green hover:text-ie-green transition-colors"
        >
          \u2713
        </button>
      )}

      {/* Already confirmed indicator */}
      {pruefstatus && (
        <span className={`text-[9px] px-1.5 py-px rounded-sm font-mono border ${
          pruefstatus === 'bestaetigt' ? 'border-ie-green/30 text-ie-green bg-ie-green/5'
          : 'border-ie-blue/30 text-ie-blue bg-ie-blue/5'
        }`}>
          {pruefstatus === 'bestaetigt' ? 'OK' : pruefstatus === 'korrigiert' ? 'KORR.' : 'MANUELL'}
        </span>
      )}
    </div>
  );
}

function countStats(result: ExtractionResult, fields: FieldDef[][]): { confirmed: number; total: number; withValue: number } {
  let confirmed = 0;
  let total = 0;
  let withValue = 0;
  for (const group of fields) {
    for (const def of group) {
      total++;
      const field = getField(result, def.path);
      if (fieldHasValue(field)) withValue++;
      if (field?.pruefstatus) confirmed++;
    }
  }
  return { confirmed, total, withValue };
}

export function PrueflisteTab({ result, onUpdateField }: PrueflisteTabProps) {
  const allFields = [VERFAHRENSDATEN_FIELDS, SCHULDNER_PERSON_FIELDS, SCHULDNER_FIRMA_FIELDS];
  const { confirmed, total } = countStats(result, allFields);
  const percent = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  return (
    <>
      {/* Progress bar */}
      <div className="bg-surface border border-border rounded-sm mb-2.5 p-3 px-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-text font-sans">Prüffortschritt</span>
          <span className="text-[11px] font-mono text-text-dim">
            {confirmed} von {total} geprüft
          </span>
        </div>
        <div className="w-full h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-ie-green rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <Section title="Verfahrensdaten" icon="\u25ce" count={VERFAHRENSDATEN_FIELDS.length}>
        {VERFAHRENSDATEN_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <Section title="Schuldner \u2014 Person" icon="\u25cf" count={SCHULDNER_PERSON_FIELDS.length}>
        {SCHULDNER_PERSON_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <Section title="Schuldner \u2014 Firma" icon="\u25a1" count={SCHULDNER_FIRMA_FIELDS.length}>
        {SCHULDNER_FIRMA_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <div className="mt-2 p-2 px-4 text-[9px] text-text-muted">
        Diese Felder werden f\u00fcr die Erstellung der Standardanschreiben ben\u00f6tigt.
        Best\u00e4tigte und korrigierte Werte flie\u00dfen direkt in die Briefgenerierung ein.
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/extraction/tabs/PrueflisteTab.tsx
git commit -m "feat: create PrueflisteTab component with inline editing"
```

---

### Task 6: Integrate Prüfliste tab into DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Add import**

After line 15 (FehlendTab import), add:

```typescript
import { PrueflisteTab } from '../components/extraction/tabs/PrueflisteTab';
```

- [ ] **Step 2: Get updateField from hook**

In line 52, destructure `updateField` from `useExtraction()`:

```typescript
const { loading, progress, progressPercent, result, error, extractionId, extract, reset, loadDemo, loadFromHistory, updateField } = useExtraction();
```

- [ ] **Step 3: Compute unconfirmed count for badge**

After line 93 (`const missingInfo = ...`), add:

```typescript
const unconfirmedCount = useMemo(() => {
  if (!result) return 0;
  const paths = [
    'verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht',
    'schuldner.name', 'schuldner.vorname', 'schuldner.geburtsdatum',
    'schuldner.aktuelle_adresse', 'schuldner.handelsregisternummer',
    'schuldner.firma', 'schuldner.betriebsstaette_adresse',
  ];
  let count = 0;
  for (const p of paths) {
    const parts = p.split('.');
    let obj: unknown = result;
    for (const part of parts) {
      if (obj == null || typeof obj !== 'object') { obj = null; break; }
      obj = (obj as Record<string, unknown>)[part];
    }
    if (obj && typeof obj === 'object' && 'wert' in (obj as object)) {
      const field = obj as { wert: unknown; pruefstatus?: string };
      const hasVal = field.wert !== null && field.wert !== undefined && String(field.wert).trim() !== '';
      if (hasVal && !field.pruefstatus) count++;
    }
  }
  return count;
}, [result]);
```

- [ ] **Step 4: Add tab to tabs array**

In the `tabs` useMemo (line 95-103), add the Prüfliste tab at position 6 (after 'ermittlung', before 'briefe'):

```typescript
const tabs = useMemo(() => [
  { id: 'overview', label: 'Übersicht', icon: '\u25ce' },
  { id: 'schuldner', label: 'Schuldner', icon: '\u25cf' },
  { id: 'antragsteller', label: 'Antragsteller', icon: '\u25c6' },
  { id: 'forderungen', label: 'Forderungen', icon: '\u20ac' },
  { id: 'ermittlung', label: 'Ermittlung', icon: '\u25d0' },
  { id: 'pruefliste', label: 'Prüfliste', icon: '\u2713', badge: unconfirmedCount },
  { id: 'briefe', label: 'Anschreiben', icon: '\u2709', badge: bereit },
  { id: 'fehlend', label: 'Fehlend', icon: '\u25b3', badge: missingInfo.length },
], [bereit, missingInfo.length, unconfirmedCount]);
```

- [ ] **Step 5: Add tab content rendering**

After the `ermittlung` tab rendering (around line 132), before the `briefe` tab, add:

```tsx
{tab === 'pruefliste' && (
  <PrueflisteTab result={result} onUpdateField={updateField} />
)}
```

- [ ] **Step 6: Verify it compiles and renders**

Run: `cd frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
git commit -m "feat: integrate Prüfliste tab into DashboardPage"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Start backend and frontend**

Run: `cd backend && npm run dev` (in one terminal)
Run: `cd frontend && npm run dev` (in another terminal)

- [ ] **Step 2: Test the full flow**

1. Login and run an extraction (or load demo)
2. Verify "Prüfliste" tab appears between "Ermittlung" and "Anschreiben"
3. Verify badge shows count of unconfirmed fields with values
4. Click a value → inline edit appears → type new value → press Enter → saves
5. Click confirm button → field shows green "OK" badge
6. Click "Eintragen..." on empty field → type value → press Enter → saves as "MANUELL"
7. Switch to "Anschreiben" tab → verify letter statuses updated
8. Reload page (if from history) → verify persisted corrections are still there

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -u
git commit -m "fix: address smoke test issues in Prüfliste tab"
```
