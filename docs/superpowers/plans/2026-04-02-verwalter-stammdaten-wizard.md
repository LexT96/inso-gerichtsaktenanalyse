# Verwalter-Stammdaten + Gutachten Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat GutachtenDialog with a 4-step wizard backed by persisted Verwalter profiles, so lawyers select their name from a dropdown instead of re-entering details every time.

**Architecture:** New SQLite table `verwalter_profiles` with CRUD API. Frontend wizard component replaces `GutachtenDialog`, reusing the existing prepare/generate API endpoints. Wizard assembles the same `GutachtenUserInputs` object.

**Tech Stack:** SQLite (better-sqlite3), Express routes, React (useState wizard steps), Tailwind CSS, existing apiClient (axios + MSAL auth)

---

### Task 1: Database Migration

**Files:**
- Create: `backend/src/db/migrations/003_add_verwalter_profiles.sql`

- [ ] **Step 1: Create migration file**

```sql
CREATE TABLE IF NOT EXISTS verwalter_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  titel TEXT DEFAULT '',
  geschlecht TEXT NOT NULL DEFAULT 'maennlich' CHECK(geschlecht IN ('maennlich', 'weiblich')),
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

- [ ] **Step 2: Verify migration runs**

Run from project root:
```bash
cd backend && npx tsx -e "
import { initDatabase } from './src/db/database';
const db = initDatabase('./data/insolvenz.db');
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='verwalter_profiles'\").all();
console.log('verwalter_profiles exists:', tables.length > 0);
const cols = db.pragma('table_info(verwalter_profiles)');
console.log('Columns:', cols.map((c: any) => c.name).join(', '));
"
```
Expected: `verwalter_profiles exists: true` and all 12 columns listed.

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/migrations/003_add_verwalter_profiles.sql
git commit -m "feat: add verwalter_profiles migration"
```

---

### Task 2: Backend API Routes

**Files:**
- Create: `backend/src/routes/verwalter.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Create verwalter route file**

Create `backend/src/routes/verwalter.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const router = Router();

// GET /api/verwalter — list all profiles
router.get('/', authMiddleware, (_req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM verwalter_profiles ORDER BY name').all();
  res.json(rows);
});

// POST /api/verwalter — create profile
router.post('/', authMiddleware, (req: Request, res: Response): void => {
  const { name, titel, geschlecht, diktatzeichen, sachbearbeiter_name, sachbearbeiter_email, sachbearbeiter_durchwahl, standort, anderkonto_iban, anderkonto_bank } = req.body as Record<string, string>;

  if (!name?.trim()) {
    res.status(400).json({ error: 'Name ist erforderlich' });
    return;
  }

  const db = getDb();
  const result = db.prepare(
    `INSERT INTO verwalter_profiles (name, titel, geschlecht, diktatzeichen, sachbearbeiter_name, sachbearbeiter_email, sachbearbeiter_durchwahl, standort, anderkonto_iban, anderkonto_bank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name.trim(),
    titel?.trim() || '',
    geschlecht === 'weiblich' ? 'weiblich' : 'maennlich',
    diktatzeichen?.trim() || '',
    sachbearbeiter_name?.trim() || '',
    sachbearbeiter_email?.trim() || '',
    sachbearbeiter_durchwahl?.trim() || '',
    standort?.trim() || '',
    anderkonto_iban?.trim() || '',
    anderkonto_bank?.trim() || '',
  );

  const row = db.prepare('SELECT * FROM verwalter_profiles WHERE id = ?').get(Number(result.lastInsertRowid));
  logger.info('Verwalter-Profil erstellt', { id: result.lastInsertRowid, name: name.trim() });
  res.status(201).json(row);
});

// PUT /api/verwalter/:id — update profile
router.put('/:id', authMiddleware, (req: Request, res: Response): void => {
  const id = Number(req.params.id);
  const db = getDb();

  const existing = db.prepare('SELECT id FROM verwalter_profiles WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Profil nicht gefunden' });
    return;
  }

  const fields = ['name', 'titel', 'geschlecht', 'diktatzeichen', 'sachbearbeiter_name', 'sachbearbeiter_email', 'sachbearbeiter_durchwahl', 'standort', 'anderkonto_iban', 'anderkonto_bank'];
  const updates: string[] = [];
  const values: unknown[] = [];

  for (const field of fields) {
    if (field in req.body) {
      updates.push(`${field} = ?`);
      values.push(typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field]);
    }
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'Keine Felder zum Aktualisieren' });
    return;
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE verwalter_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM verwalter_profiles WHERE id = ?').get(id);
  logger.info('Verwalter-Profil aktualisiert', { id });
  res.json(row);
});

// DELETE /api/verwalter/:id — delete profile
router.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  const id = Number(req.params.id);
  const db = getDb();

  const result = db.prepare('DELETE FROM verwalter_profiles WHERE id = ?').run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Profil nicht gefunden' });
    return;
  }

  logger.info('Verwalter-Profil gelöscht', { id });
  res.json({ ok: true });
});

export default router;
```

- [ ] **Step 2: Register routes in index.ts**

In `backend/src/index.ts`, add the import and route registration. Find the existing route imports (like `import historyRoutes from './routes/history'`) and add alongside them:

```typescript
import verwalterRoutes from './routes/verwalter';
```

Find the existing `app.use('/api/history'` line and add alongside it:

```typescript
app.use('/api/verwalter', verwalterRoutes);
```

- [ ] **Step 3: Verify compilation**

```bash
cd backend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/verwalter.ts backend/src/index.ts
git commit -m "feat: add verwalter CRUD API routes"
```

---

### Task 3: Frontend Hook + Type

**Files:**
- Create: `frontend/src/hooks/useVerwalter.ts`
- Modify: `frontend/src/types/extraction.ts`

- [ ] **Step 1: Add VerwalterProfile type**

In `frontend/src/types/extraction.ts`, add at the end of the file (before the closing, or after the last export):

```typescript
export interface VerwalterProfile {
  id: number;
  name: string;
  titel: string;
  geschlecht: 'maennlich' | 'weiblich';
  diktatzeichen: string;
  sachbearbeiter_name: string;
  sachbearbeiter_email: string;
  sachbearbeiter_durchwahl: string;
  standort: string;
  anderkonto_iban: string;
  anderkonto_bank: string;
}
```

Note: This file currently re-exports from `@shared/types/extraction`. Add the `VerwalterProfile` interface directly in this file (not in shared) since it's frontend+backend only, not part of the extraction data model.

- [ ] **Step 2: Create useVerwalter hook**

Create `frontend/src/hooks/useVerwalter.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { VerwalterProfile } from '../types/extraction';

export function useVerwalter() {
  const [profiles, setProfiles] = useState<VerwalterProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProfiles = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/verwalter');
      setProfiles(data);
    } catch {
      // Silently fail — profiles just won't be available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const createProfile = useCallback(async (profile: Omit<VerwalterProfile, 'id'>) => {
    const { data } = await apiClient.post('/verwalter', profile);
    setProfiles(prev => [...prev, data]);
    return data as VerwalterProfile;
  }, []);

  const updateProfile = useCallback(async (id: number, updates: Partial<VerwalterProfile>) => {
    const { data } = await apiClient.put(`/verwalter/${id}`, updates);
    setProfiles(prev => prev.map(p => p.id === id ? data : p));
    return data as VerwalterProfile;
  }, []);

  const deleteProfile = useCallback(async (id: number) => {
    await apiClient.delete(`/verwalter/${id}`);
    setProfiles(prev => prev.filter(p => p.id !== id));
  }, []);

  return { profiles, loading, createProfile, updateProfile, deleteProfile, refetch: fetchProfiles };
}
```

- [ ] **Step 3: Verify compilation**

```bash
cd frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useVerwalter.ts frontend/src/types/extraction.ts
git commit -m "feat: add VerwalterProfile type and useVerwalter hook"
```

---

### Task 4: VerwalterManager Component

**Files:**
- Create: `frontend/src/components/extraction/VerwalterManager.tsx`

- [ ] **Step 1: Create VerwalterManager**

Create `frontend/src/components/extraction/VerwalterManager.tsx`:

```typescript
import { useState } from 'react';
import type { VerwalterProfile } from '../../types/extraction';

interface VerwalterManagerProps {
  profiles: VerwalterProfile[];
  onSave: (profile: Omit<VerwalterProfile, 'id'>) => Promise<VerwalterProfile>;
  onUpdate: (id: number, updates: Partial<VerwalterProfile>) => Promise<VerwalterProfile>;
  onDelete: (id: number) => Promise<void>;
  onClose: () => void;
}

const EMPTY_PROFILE: Omit<VerwalterProfile, 'id'> = {
  name: '', titel: '', geschlecht: 'maennlich', diktatzeichen: '',
  sachbearbeiter_name: '', sachbearbeiter_email: '', sachbearbeiter_durchwahl: '',
  standort: '', anderkonto_iban: '', anderkonto_bank: '',
};

export function VerwalterManager({ profiles, onSave, onUpdate, onDelete, onClose }: VerwalterManagerProps) {
  const [editing, setEditing] = useState<VerwalterProfile | Omit<VerwalterProfile, 'id'> | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!editing || !editing.name.trim()) return;
    setSaving(true);
    try {
      if ('id' in editing) {
        await onUpdate(editing.id, editing);
      } else {
        await onSave(editing);
      }
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Verwalter-Profil wirklich löschen?')) return;
    await onDelete(id);
  };

  const updateField = (field: string, value: string) => {
    if (!editing) return;
    setEditing({ ...editing, [field]: value });
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text">Verwalter-Profile verwalten</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg">×</button>
        </div>

        {editing ? (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Name *</label>
                <input value={editing.name} onChange={e => updateField('name', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="RA Dr. Alexander Lamberty LL.M." />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Titel</label>
                <input value={editing.titel} onChange={e => updateField('titel', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Fachanwalt für Insolvenz- und Sanierungsrecht" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Geschlecht</label>
                <select value={editing.geschlecht} onChange={e => updateField('geschlecht', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text">
                  <option value="maennlich">männlich</option>
                  <option value="weiblich">weiblich</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Diktatzeichen</label>
                <input value={editing.diktatzeichen} onChange={e => updateField('diktatzeichen', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="La/Bi" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Sachbearbeiter</label>
                <input value={editing.sachbearbeiter_name} onChange={e => updateField('sachbearbeiter_name', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Christoph Orthen LL.M." />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">E-Mail Sachbearbeiter</label>
                <input value={editing.sachbearbeiter_email} onChange={e => updateField('sachbearbeiter_email', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="name@tbs-insolvenzverwalter.de" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Durchwahl</label>
                <input value={editing.sachbearbeiter_durchwahl} onChange={e => updateField('sachbearbeiter_durchwahl', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="0651 / 170 830 - 124" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Standort</label>
                <input value={editing.standort} onChange={e => updateField('standort', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Zell/Mosel" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Anderkonto IBAN</label>
                <input value={editing.anderkonto_iban} onChange={e => updateField('anderkonto_iban', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text font-mono" placeholder="DE__ ____ ____ ____" />
              </div>
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Anderkonto Bank</label>
                <input value={editing.anderkonto_bank} onChange={e => updateField('anderkonto_bank', e.target.value)}
                  className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text" placeholder="Sparkasse Trier" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-4 py-1.5 text-[11px] text-text-muted hover:text-text">Abbrechen</button>
              <button onClick={handleSave} disabled={saving || !editing.name.trim()}
                className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4">
            {profiles.length === 0 ? (
              <p className="text-[11px] text-text-muted text-center py-6">Noch keine Profile angelegt.</p>
            ) : (
              <div className="space-y-1">
                {profiles.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 px-3 border border-border/60 rounded hover:bg-bg/50">
                    <div>
                      <div className="text-[11px] font-semibold text-text">{p.name}</div>
                      <div className="text-[9px] text-text-dim">{p.diktatzeichen} · {p.standort} · {p.sachbearbeiter_name}</div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setEditing(p)} className="px-2 py-1 text-[9px] text-text-muted hover:text-text border border-border rounded">Bearbeiten</button>
                      <button onClick={() => handleDelete(p.id)} className="px-2 py-1 text-[9px] text-red-400 hover:text-red-300 border border-border rounded">Löschen</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setEditing({ ...EMPTY_PROFILE })}
              className="mt-3 w-full py-2 border border-dashed border-border rounded text-[11px] text-text-muted hover:text-text hover:border-text-muted">
              + Neuer Verwalter
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/extraction/VerwalterManager.tsx
git commit -m "feat: add VerwalterManager CRUD component"
```

---

### Task 5: GutachtenWizard Component

**Files:**
- Create: `frontend/src/components/extraction/GutachtenWizard.tsx`

- [ ] **Step 1: Create GutachtenWizard**

Create `frontend/src/components/extraction/GutachtenWizard.tsx`. This is the largest file — it replaces GutachtenDialog with a 4-step wizard.

```typescript
import { useState, useMemo } from 'react';
import { apiClient } from '../../api/client';
import { useVerwalter } from '../../hooks/useVerwalter';
import { VerwalterManager } from './VerwalterManager';
import type { ExtractionResult, VerwalterProfile, Pruefstatus } from '../../types/extraction';

interface GutachtenWizardProps {
  result: ExtractionResult;
  extractionId: number;
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
  onClose: () => void;
}

type TemplateType = 'juristische_person' | 'personengesellschaft' | 'natuerliche_person';

interface SlotData {
  id: string;
  context: string;
  original: string;
  value: string;
  hint: string;
  status: 'filled' | 'todo' | 'editorial';
}

const JURISTISCHE_KEYWORDS = ['GmbH', 'UG', 'AG', 'SE', 'eG', 'gGmbH', 'KGaA', 'e.V.', 'Stiftung'];
const PERSONEN_KEYWORDS = ['OHG', 'KG', 'GbR', 'PartG'];

function detectTemplateType(rechtsform: string | null | undefined): TemplateType {
  if (!rechtsform) return 'natuerliche_person';
  const rf = rechtsform.trim();
  if (JURISTISCHE_KEYWORDS.some(k => rf.includes(k))) return 'juristische_person';
  if (PERSONEN_KEYWORDS.some(k => rf.includes(k))) return 'personengesellschaft';
  return 'natuerliche_person';
}

function templateLabel(type: TemplateType): string {
  switch (type) {
    case 'juristische_person': return 'juristische Person';
    case 'personengesellschaft': return 'Personengesellschaft';
    case 'natuerliche_person': return 'natürliche Person';
  }
}

const STEP_LABELS = ['Verwalter', 'Schuldner & Verfahren', 'Fehlende Angaben', 'Generieren'];

export function GutachtenWizard({ result, extractionId, onUpdateField, onClose }: GutachtenWizardProps) {
  const [step, setStep] = useState(1);
  const [selectedVerwalter, setSelectedVerwalter] = useState<VerwalterProfile | null>(null);
  const [showManager, setShowManager] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [slots, setSlots] = useState<SlotData[]>([]);

  // Extra inputs not covered by Verwalter profile or extraction
  const [anderkontoIban, setAnderkontoIban] = useState('');
  const [anderkontoBank, setAnderkontoBank] = useState('');
  const [geschaeftsfuehrer, setGeschaeftsfuehrer] = useState('');
  const [lastGavv, setLastGavv] = useState('');

  const { profiles, loading: loadingProfiles, createProfile, updateProfile, deleteProfile } = useVerwalter();

  const templateType = useMemo(
    () => detectTemplateType(result.schuldner?.rechtsform?.wert as string | null),
    [result.schuldner?.rechtsform?.wert],
  );
  const isJuristisch = templateType === 'juristische_person';
  const isNatuerlich = templateType === 'natuerliche_person';

  // When Verwalter is selected, pre-fill anderkonto if available
  const handleSelectVerwalter = (profile: VerwalterProfile) => {
    setSelectedVerwalter(profile);
    if (profile.anderkonto_iban) setAnderkontoIban(profile.anderkonto_iban);
    if (profile.anderkonto_bank) setAnderkontoBank(profile.anderkonto_bank);
  };

  // Key fields to check in Step 2
  const schuldnerFields = useMemo(() => {
    const s = result.schuldner;
    const v = result.verfahrensdaten;
    const base = [
      { label: 'Aktenzeichen', value: v?.aktenzeichen?.wert, path: 'verfahrensdaten.aktenzeichen' },
      { label: 'Gericht', value: v?.gericht?.wert, path: 'verfahrensdaten.gericht' },
      { label: 'Beschlussdatum', value: v?.beschlussdatum?.wert, path: 'verfahrensdaten.beschlussdatum' },
    ];
    if (isJuristisch || templateType === 'personengesellschaft') {
      base.push(
        { label: 'Firma', value: s?.firma?.wert, path: 'schuldner.firma' },
        { label: 'Rechtsform', value: s?.rechtsform?.wert, path: 'schuldner.rechtsform' },
        { label: 'Betriebsstätte', value: s?.betriebsstaette_adresse?.wert, path: 'schuldner.betriebsstaette_adresse' },
        { label: 'HRB', value: s?.handelsregisternummer?.wert, path: 'schuldner.handelsregisternummer' },
      );
    } else {
      base.push(
        { label: 'Name', value: s?.name?.wert, path: 'schuldner.name' },
        { label: 'Vorname', value: s?.vorname?.wert, path: 'schuldner.vorname' },
        { label: 'Geburtsdatum', value: s?.geburtsdatum?.wert, path: 'schuldner.geburtsdatum' },
        { label: 'Familienstand', value: s?.familienstand?.wert, path: 'schuldner.familienstand' },
        { label: 'Adresse', value: s?.aktuelle_adresse?.wert, path: 'schuldner.aktuelle_adresse' },
        { label: 'Firma', value: s?.firma?.wert, path: 'schuldner.firma' },
      );
    }
    return base;
  }, [result, isJuristisch, templateType]);

  const missingCount = schuldnerFields.filter(f => !f.value).length;

  const buildUserInputs = (): Record<string, string> => {
    const body: Record<string, string> = {
      verwalter_diktatzeichen: selectedVerwalter?.diktatzeichen || '',
      verwalter_geschlecht: selectedVerwalter?.geschlecht || 'maennlich',
    };
    if (anderkontoIban.trim()) body.anderkonto_iban = anderkontoIban.trim();
    if (anderkontoBank.trim()) body.anderkonto_bank = anderkontoBank.trim();
    if (isJuristisch && geschaeftsfuehrer.trim()) body.geschaeftsfuehrer = geschaeftsfuehrer.trim();
    if (isNatuerlich && lastGavv.trim()) body.last_gavv = lastGavv.trim();
    return body;
  };

  const handlePrepare = async () => {
    setPreparing(true);
    setError('');
    try {
      const body = buildUserInputs();
      const response = await apiClient.post(`/generate-gutachten/${extractionId}/prepare`, body);
      const returnedSlots: SlotData[] = (response.data.slots || []).map((s: SlotData) => ({
        id: s.id, context: s.context || '', original: s.original || '',
        value: s.value || '', hint: s.hint || s.original || '', status: s.status,
      }));
      setSlots(returnedSlots);
    } catch (err) {
      const axErr = err as { response?: { data?: { error?: string } } };
      setError(axErr?.response?.data?.error || 'Vorbereitung fehlgeschlagen');
    } finally {
      setPreparing(false);
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError('');
    try {
      const finalSlots = slots.map(s => ({ id: s.id, value: s.value }));
      const body = { userInputs: buildUserInputs(), slots: finalSlots };
      const response = await apiClient.post(
        `/generate-gutachten/${extractionId}/generate`, body, { responseType: 'blob' },
      );
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Gutachten_${extractionId}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      const axErr = err as { response?: { data?: Blob } };
      if (axErr?.response?.data instanceof Blob) {
        try {
          const text = await axErr.response.data.text();
          setError(JSON.parse(text).error || 'Generierung fehlgeschlagen');
        } catch {
          setError('Generierung fehlgeschlagen');
        }
      } else {
        setError('Generierung fehlgeschlagen');
      }
    } finally {
      setGenerating(false);
    }
  };

  const canAdvance = (s: number): boolean => {
    if (s === 1) return selectedVerwalter !== null;
    return true;
  };

  const filledSlots = slots.filter(s => s.status === 'filled').length;
  const todoSlots = slots.filter(s => s.status === 'todo').length;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header with step indicators */}
        <div className="flex items-center gap-1 p-3 border-b border-border">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-border mx-1">›</span>}
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                i + 1 === step ? 'bg-accent text-white font-bold' :
                i + 1 < step ? 'bg-accent/20 text-accent' : 'text-text-dim'
              }`}>
                {i + 1}
              </span>
              <span className={`text-[10px] ${i + 1 === step ? 'text-text font-semibold' : 'text-text-dim'}`}>
                {label}
              </span>
            </div>
          ))}
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">×</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-3 p-2 bg-red-900/20 border border-red-800/40 rounded text-[11px] text-red-300">{error}</div>
          )}

          {/* Step 1: Verwalter */}
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Verwalter/in auswählen *</label>
                <select
                  value={selectedVerwalter?.id || ''}
                  onChange={e => {
                    const p = profiles.find(p => p.id === Number(e.target.value));
                    if (p) handleSelectVerwalter(p);
                  }}
                  className="w-full px-2 py-2 bg-bg border border-border rounded text-[12px] text-text"
                >
                  <option value="">— Bitte wählen —</option>
                  {profiles.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {selectedVerwalter && (
                <div className="grid grid-cols-2 gap-2">
                  {[
                    ['Diktatzeichen', selectedVerwalter.diktatzeichen],
                    ['Geschlecht', selectedVerwalter.geschlecht === 'weiblich' ? 'weiblich' : 'männlich'],
                    ['Standort', selectedVerwalter.standort],
                    ['Sachbearbeiter', selectedVerwalter.sachbearbeiter_name],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-bg border border-border/60 rounded px-3 py-2">
                      <div className="text-[9px] text-text-dim">{l}</div>
                      <div className="text-[12px] text-text">{v || '—'}</div>
                    </div>
                  ))}
                </div>
              )}
              {loadingProfiles ? (
                <p className="text-[10px] text-text-muted">Lade Profile…</p>
              ) : profiles.length === 0 ? (
                <p className="text-[10px] text-text-muted">Noch keine Verwalter-Profile angelegt.</p>
              ) : null}
              <button onClick={() => setShowManager(true)}
                className="text-[10px] text-accent hover:underline">
                Verwalter-Profile verwalten
              </button>
            </div>
          )}

          {/* Step 2: Schuldner & Verfahren */}
          {step === 2 && (
            <div className="space-y-3">
              {missingCount > 0 && (
                <div className="p-2 bg-accent/10 border border-accent/30 rounded text-[11px] text-accent">
                  ⚠ {missingCount} Feld{missingCount > 1 ? 'er' : ''} fehlt — bitte ergänzen
                </div>
              )}
              {missingCount === 0 && (
                <div className="p-2 bg-green-900/20 border border-green-800/40 rounded text-[11px] text-green-400">
                  ✓ Alle Pflichtfelder vorhanden
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {schuldnerFields.map(f => {
                  const empty = !f.value;
                  return (
                    <div key={f.path} className={`px-3 py-2 rounded border ${
                      empty ? 'border-accent/50 bg-accent/5' : 'border-border/60 bg-bg'
                    }`}>
                      <div className={`text-[9px] ${empty ? 'text-accent' : 'text-text-dim'}`}>
                        {f.label} {empty && '⚠'}
                      </div>
                      {empty ? (
                        <input
                          className="w-full text-[12px] bg-transparent border-none outline-none text-accent placeholder-accent/40 mt-0.5"
                          placeholder="Eingeben…"
                          onBlur={e => {
                            if (e.target.value.trim()) {
                              onUpdateField(f.path, e.target.value.trim(), 'manuell');
                            }
                          }}
                        />
                      ) : (
                        <div className="text-[12px] text-text truncate">{String(f.value)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3: Fehlende Angaben */}
          {step === 3 && (
            <div className="space-y-3">
              {!selectedVerwalter?.anderkonto_iban && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Anderkonto IBAN</label>
                  <input value={anderkontoIban} onChange={e => setAnderkontoIban(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text font-mono"
                    placeholder="DE__ ____ ____ ____ ____ __" />
                </div>
              )}
              {!selectedVerwalter?.anderkonto_bank && !anderkontoBank && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Anderkonto Bank</label>
                  <input value={anderkontoBank} onChange={e => setAnderkontoBank(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text"
                    placeholder="z.B. Sparkasse Trier" />
                </div>
              )}
              {isJuristisch && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Geschäftsführer</label>
                  <input value={geschaeftsfuehrer} onChange={e => setGeschaeftsfuehrer(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text"
                    placeholder="Name des Geschäftsführers" />
                </div>
              )}
              {isNatuerlich && (
                <div>
                  <label className="text-[10px] text-text-dim block mb-1">Last GAVV</label>
                  <input value={lastGavv} onChange={e => setLastGavv(e.target.value)}
                    className="w-full px-2 py-1.5 bg-bg border border-border rounded text-[11px] text-text"
                    placeholder="Datum der letzten GAVV" />
                </div>
              )}
              {selectedVerwalter?.anderkonto_iban && !isJuristisch && !lastGavv && (
                <div className="p-3 bg-green-900/20 border border-green-800/40 rounded text-[11px] text-green-400 text-center">
                  ✓ Alle Angaben vorhanden — Gutachten kann generiert werden
                </div>
              )}
            </div>
          )}

          {/* Step 4: Vorschau & Generieren */}
          {step === 4 && (
            <div className="space-y-4">
              {!preparing && slots.length === 0 && (
                <div className="text-center py-6">
                  <p className="text-[11px] text-text-muted mb-3">Gutachten wird vorbereitet — KI füllt Textbausteine aus.</p>
                  <button onClick={handlePrepare}
                    className="px-6 py-2 bg-accent text-white rounded text-[11px] font-semibold">
                    Vorbereitung starten
                  </button>
                </div>
              )}
              {preparing && (
                <div className="text-center py-8">
                  <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
                  <p className="text-[11px] text-text-muted">KI-Textbausteine werden generiert…</p>
                </div>
              )}
              {slots.length > 0 && !preparing && (
                <>
                  <div className="flex gap-3">
                    <div className="flex-1 bg-bg border border-border rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-green-400">{filledSlots}</div>
                      <div className="text-[9px] text-text-dim">KI-Felder gefüllt</div>
                    </div>
                    <div className="flex-1 bg-bg border border-border rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-amber-400">{todoSlots}</div>
                      <div className="text-[9px] text-text-dim">TODO (manuell)</div>
                    </div>
                    <div className="flex-1 bg-bg border border-border rounded-lg p-3 text-center">
                      <div className="text-xl font-bold text-text">{slots.length}</div>
                      <div className="text-[9px] text-text-dim">Slots gesamt</div>
                    </div>
                  </div>
                  <div className="bg-bg border border-border rounded-lg p-3">
                    <div className="text-[10px] text-text-dim mb-1">Vorlage</div>
                    <div className="text-[12px] text-text font-semibold">Gutachten Muster {templateLabel(templateType)}</div>
                  </div>
                  <button onClick={handleGenerate} disabled={generating}
                    className="w-full py-3 bg-accent text-white rounded-md text-[12px] font-mono font-semibold hover:bg-accent/90 disabled:opacity-50 transition-all tracking-wide active:scale-[0.98]">
                    {generating ? 'Wird generiert…' : 'GUTACHTEN GENERIEREN'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer with navigation */}
        <div className="flex justify-between p-3 border-t border-border">
          <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
            className="px-4 py-1.5 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
            ← Zurück
          </button>
          {step < 4 ? (
            <button onClick={() => {
              if (step === 3) handlePrepare(); // Start preparation when moving to step 4
              setStep(s => Math.min(4, s + 1));
            }} disabled={!canAdvance(step)}
              className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
              Weiter →
            </button>
          ) : (
            <div /> // Generate button is in the step 4 content
          )}
        </div>
      </div>

      {/* Verwalter Manager overlay */}
      {showManager && (
        <VerwalterManager
          profiles={profiles}
          onSave={createProfile}
          onUpdate={updateProfile}
          onDelete={deleteProfile}
          onClose={() => setShowManager(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/extraction/GutachtenWizard.tsx
git commit -m "feat: add GutachtenWizard 4-step component"
```

---

### Task 6: Wire Up — Replace GutachtenDialog with GutachtenWizard

**Files:**
- Modify: `frontend/src/components/extraction/tabs/GutachtenTab.tsx`
- Delete: `frontend/src/components/extraction/GutachtenDialog.tsx`

- [ ] **Step 1: Update GutachtenTab imports and usage**

In `frontend/src/components/extraction/tabs/GutachtenTab.tsx`:

Replace the import:
```typescript
// OLD:
import { GutachtenDialog } from '../GutachtenDialog';
// NEW:
import { GutachtenWizard } from '../GutachtenWizard';
```

Replace the dialog rendering (find `{showDialog && (` near the bottom):
```typescript
// OLD:
{showDialog && (
  <GutachtenDialog
    result={result}
    extractionId={extractionId}
    onClose={() => setShowDialog(false)}
  />
)}

// NEW:
{showDialog && (
  <GutachtenWizard
    result={result}
    extractionId={extractionId}
    onUpdateField={onUpdateField}
    onClose={() => setShowDialog(false)}
  />
)}
```

- [ ] **Step 2: Delete old GutachtenDialog**

```bash
rm frontend/src/components/extraction/GutachtenDialog.tsx
```

- [ ] **Step 3: Verify full build**

```bash
cd frontend && npx tsc --noEmit && npm run build
cd ../backend && npx tsc --noEmit
```
Expected: all pass, no references to deleted GutachtenDialog.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: replace GutachtenDialog with GutachtenWizard

4-step wizard: Verwalter auswählen → Schuldner prüfen → Fehlende Angaben → Generieren
Persisted Verwalter profiles via /api/verwalter CRUD
Removes GutachtenDialog.tsx"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```
