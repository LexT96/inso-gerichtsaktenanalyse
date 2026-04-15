# Add Documents to Existing Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to upload additional documents (Grundbuchauszug, Forderungsanmeldung, etc.) to an existing extraction, with targeted extraction, authority-based merge suggestions, and user-confirmed application.

**Architecture:** New `documents` table tracks multiple PDFs per extraction. Upload → classify document type → run matching field pack → diff against existing result → user reviews and confirms changes. PDF viewer shows all documents concatenated with separators.

**Tech Stack:** TypeScript, Express, SQLite (better-sqlite3), React, existing field pack infrastructure (anchorExtractor, scalarPackExtractor, fieldAuthority)

**Spec:** `docs/superpowers/specs/2026-04-15-add-documents-to-extraction-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/db/migrations/005_add_documents.sql` | Create | New `documents` table |
| `backend/src/db/database.ts` | Modify | Backfill existing extractions + migrate PDF files on startup |
| `backend/src/types/extraction.ts` | Modify | Add `DocumentInfo`, `MergeDiff` types |
| `shared/types/extraction.ts` | Modify | Mirror `DocumentInfo`, `MergeDiff` types |
| `backend/src/services/documentMerge.ts` | Create | Diff + merge logic (compare candidates vs existing result) |
| `backend/src/routes/documents.ts` | Create | 3 endpoints: upload+classify, extract+diff, apply |
| `backend/src/routes/history.ts` | Modify | Update PDF serving for new directory structure |
| `backend/src/services/extraction.ts` | Modify | Update PDF save path for new extractions |
| `backend/src/index.ts` | Modify | Register new documents route |
| `frontend/src/components/extraction/AddDocumentWizard.tsx` | Create | 4-step modal (upload, classify, extract, review) |
| `frontend/src/components/extraction/MergeSummary.tsx` | Create | Diff review screen with checkboxes |
| `frontend/src/components/pdf/PdfViewer.tsx` | Modify | Support multiple File objects, concatenated with separators |
| `frontend/src/pages/DashboardPage.tsx` | Modify | Add "Dokument hinzufügen" button + wire up wizard |

---

### Task 1: Database Migration + Types

**Files:**
- Create: `backend/src/db/migrations/005_add_documents.sql`
- Modify: `backend/src/types/extraction.ts`
- Modify: `shared/types/extraction.ts`

- [ ] **Step 1: Create the migration file**

```sql
-- backend/src/db/migrations/005_add_documents.sql
-- Track multiple documents per extraction (Gerichtsakte + supplements).
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id INTEGER NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  doc_index INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  pdf_hash TEXT,
  uploaded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(extraction_id, doc_index)
);
```

- [ ] **Step 2: Add types to `backend/src/types/extraction.ts`**

Add at the end of the file:

```typescript
// ─── Document Management Types ───

export interface DocumentInfo {
  id: number;
  extractionId: number;
  docIndex: number;
  sourceType: SegmentSourceType | 'gerichtsakte';
  originalFilename: string;
  pageCount: number;
  pdfHash?: string;
  uploadedAt: string;
}

export interface MergeFieldChange {
  path: string;
  wert: unknown;
  quelle: string;
  oldWert?: unknown;
  oldQuelle?: string;
  reason?: string;
}

export interface MergeDiff {
  newFields: MergeFieldChange[];
  updatedFields: MergeFieldChange[];
  conflicts: MergeFieldChange[];
  newForderungen: Array<{ index: number; glaeubiger: string; betrag: number | null; quelle: string }>;
  updatedForderungen: Array<{ existingIndex: number; glaeubiger: string; oldBetrag: number | null; newBetrag: number | null; quelle: string }>;
}

export interface ApplyRequest {
  acceptAll?: boolean;
  accept?: string[];
  reject?: string[];
  forderungen?: { add?: number[]; update?: number[] };
}
```

- [ ] **Step 3: Mirror types in `shared/types/extraction.ts`**

Add the same `DocumentInfo`, `MergeFieldChange`, `MergeDiff`, and `ApplyRequest` types.

- [ ] **Step 4: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: clean compile

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrations/005_add_documents.sql backend/src/types/extraction.ts shared/types/extraction.ts
git commit -m "feat: documents table migration + DocumentInfo/MergeDiff types"
```

---

### Task 2: PDF Storage Migration + Backfill

**Files:**
- Modify: `backend/src/db/database.ts`
- Modify: `backend/src/services/extraction.ts`
- Modify: `backend/src/routes/history.ts`

- [ ] **Step 1: Read `backend/src/db/database.ts` to understand the migration runner and `initDatabase()` function**

- [ ] **Step 2: Add backfill logic after migration runner in `database.ts`**

After all migrations run in `initDatabase()`, add a backfill step:

```typescript
// Backfill: create document records for existing extractions that have no documents entry
const existingWithoutDocs = db.prepare(`
  SELECT e.id, e.filename FROM extractions e
  WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.extraction_id = e.id)
  AND e.status = 'completed'
`).all() as Array<{ id: number; filename: string }>;

if (existingWithoutDocs.length > 0) {
  const insert = db.prepare(`
    INSERT INTO documents (extraction_id, doc_index, source_type, original_filename, page_count)
    VALUES (?, 0, 'gerichtsakte', ?, 0)
  `);
  for (const row of existingWithoutDocs) {
    insert.run(row.id, row.filename);
  }
  logger.info('Dokumente-Backfill abgeschlossen', { count: existingWithoutDocs.length });

  // Migrate PDF files: data/pdfs/{id}.pdf → data/pdfs/{id}/0_gerichtsakte.pdf
  const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
  for (const row of existingWithoutDocs) {
    const oldPath = path.join(pdfDir, `${row.id}.pdf`);
    const newDir = path.join(pdfDir, String(row.id));
    const newPath = path.join(newDir, '0_gerichtsakte.pdf');
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
    }
  }
}
```

Add necessary imports: `path`, `fs`, `config`, `logger` (check which are already imported).

- [ ] **Step 3: Update PDF save path in `backend/src/services/extraction.ts`**

Find the PDF save block (around line 668):
```typescript
// OLD:
fs.writeFileSync(path.join(pdfDir, `${extractionId}.pdf`), pdfBuffer);
```
Replace with:
```typescript
// NEW: save into extraction-specific directory
const extractionPdfDir = path.join(pdfDir, String(extractionId));
if (!fs.existsSync(extractionPdfDir)) fs.mkdirSync(extractionPdfDir, { recursive: true });
fs.writeFileSync(path.join(extractionPdfDir, '0_gerichtsakte.pdf'), pdfBuffer);
```

Also, after extraction completes successfully, insert into `documents` table:
```typescript
db.prepare(`
  INSERT OR IGNORE INTO documents (extraction_id, doc_index, source_type, original_filename, page_count)
  VALUES (?, 0, 'gerichtsakte', ?, ?)
`).run(extractionId, filename, pageCount);
```

- [ ] **Step 4: Update PDF serving in `backend/src/routes/history.ts`**

Find the `GET /:id/pdf` handler (line 112). Update the path resolution to try new path first, fall back to old:

```typescript
// NEW: try directory structure first, fall back to flat
const extractionPdfDir = path.join(pdfDir, String(id));
let pdfPath = path.join(extractionPdfDir, '0_gerichtsakte.pdf');
if (!fs.existsSync(pdfPath)) {
  // Fallback to old flat structure
  pdfPath = path.join(pdfDir, `${id}.pdf`);
}
if (!fs.existsSync(pdfPath)) {
  res.status(404).json({ error: 'PDF nicht mehr verfügbar' });
  return;
}
```

- [ ] **Step 5: Verify build**

Run: `cd backend && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/database.ts backend/src/services/extraction.ts backend/src/routes/history.ts
git commit -m "feat: migrate PDF storage to per-extraction directories with backfill"
```

---

### Task 3: Document Merge Service

**Files:**
- Create: `backend/src/services/documentMerge.ts`
- Test: `backend/src/services/__tests__/documentMerge.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// backend/src/services/__tests__/documentMerge.test.ts
import { describe, it, expect } from 'vitest';
import { computeMergeDiff } from '../documentMerge';
import type { ExtractionCandidate, ExtractionResult } from '../../types/extraction';

function sv(wert: string | null, quelle = ''): { wert: string | null; quelle: string } {
  return { wert, quelle };
}

function makeMinimalResult(): ExtractionResult {
  return {
    verfahrensdaten: { aktenzeichen: sv('35 IN 42/26', 'Seite 1'), gericht: sv(null) },
    schuldner: { name: sv('Müller', 'Seite 1'), aktuelle_adresse: sv('Alt 1', 'Seite 5, Antrag'), telefon: sv('0651-111', 'Seite 8') },
    forderungen: { einzelforderungen: [{ glaeubiger: sv('Sparkasse'), betrag: { wert: 12450, quelle: 'S.20' } }] },
  } as unknown as ExtractionResult;
}

describe('computeMergeDiff', () => {
  it('detects new fields (existing is null)', () => {
    const existing = makeMinimalResult();
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.gericht', wert: 'AG Trier', quelle: 'Grundbuchauszug, Seite 1', page: 1, segmentType: 'grundbuch', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.newFields).toHaveLength(1);
    expect(diff.newFields[0].path).toBe('verfahrensdaten.gericht');
    expect(diff.newFields[0].wert).toBe('AG Trier');
  });

  it('detects updated fields (authority wins)', () => {
    const existing = makeMinimalResult();
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.aktuelle_adresse', wert: 'Neu 5, 12345 Berlin', quelle: 'Meldeauskunft, Seite 1', page: 1, segmentType: 'meldeauskunft', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.updatedFields).toHaveLength(1);
    expect(diff.updatedFields[0].oldWert).toBe('Alt 1');
    expect(diff.updatedFields[0].wert).toBe('Neu 5, 12345 Berlin');
  });

  it('detects conflicts for manually corrected fields', () => {
    const existing = makeMinimalResult();
    (existing.schuldner.telefon as any).pruefstatus = 'manuell';
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.telefon', wert: '0651-222', quelle: 'Meldeauskunft, Seite 2', page: 2, segmentType: 'meldeauskunft', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.conflicts).toHaveLength(1);
    expect(diff.conflicts[0].path).toBe('schuldner.telefon');
  });

  it('skips candidates with same value as existing', () => {
    const existing = makeMinimalResult();
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.aktenzeichen', wert: '35 IN 42/26', quelle: 'Grundbuchauszug, Seite 1', page: 1, segmentType: 'grundbuch', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.newFields).toHaveLength(0);
    expect(diff.updatedFields).toHaveLength(0);
    expect(diff.conflicts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/services/__tests__/documentMerge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `backend/src/services/documentMerge.ts`**

```typescript
import { getFieldAuthority } from '../utils/fieldAuthority';
import { logger } from '../utils/logger';
import type { ExtractionResult, ExtractionCandidate, MergeDiff, MergeFieldChange, SegmentSourceType } from '../types/extraction';

/**
 * Navigate a dotted path in a nested object and return the leaf value.
 * Returns undefined if any intermediate key is missing.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Determine the source type of an existing field value based on its quelle string.
 * Heuristic: look for document type keywords in the quelle.
 */
function inferSourceType(quelle: string): SegmentSourceType {
  const q = quelle.toLowerCase();
  if (/beschluss|verfügung/.test(q)) return 'beschluss';
  if (/antrag|insolvenzantrag/.test(q)) return 'insolvenzantrag';
  if (/pzu|zustellung/.test(q)) return 'pzu';
  if (/handelsregister|hr-auszug|hrb/.test(q)) return 'handelsregister';
  if (/meldeauskunft|meldebescheinigung/.test(q)) return 'meldeauskunft';
  if (/fragebogen|formular/.test(q)) return 'fragebogen';
  if (/grundbuch/.test(q)) return 'grundbuch';
  if (/gerichtsvollzieher/.test(q)) return 'gerichtsvollzieher';
  if (/vollstreckungsportal|schuldnerverzeichnis/.test(q)) return 'vollstreckungsportal';
  return 'sonstiges';
}

/**
 * Compare extraction candidates from a new document against the existing result.
 * Categorizes each candidate as new, updated, conflict, or unchanged.
 */
export function computeMergeDiff(
  existing: ExtractionResult,
  candidates: ExtractionCandidate[],
): MergeDiff {
  const diff: MergeDiff = {
    newFields: [],
    updatedFields: [],
    conflicts: [],
    newForderungen: [],
    updatedForderungen: [],
  };

  for (const candidate of candidates) {
    const existingField = getNestedValue(existing as unknown as Record<string, unknown>, candidate.fieldPath);

    // Not a SourcedValue object — skip
    if (existingField !== undefined && existingField !== null && typeof existingField === 'object' && 'wert' in existingField) {
      const field = existingField as { wert: unknown; quelle: string; pruefstatus?: string };
      const existingWert = field.wert;
      const existingQuelle = field.quelle || '';

      // Same value — no change needed
      if (String(existingWert) === String(candidate.wert)) continue;

      // Existing is empty — new field
      if (existingWert === null || existingWert === undefined || existingWert === '') {
        diff.newFields.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
        });
        continue;
      }

      // Manual correction — always conflict
      if (field.pruefstatus === 'manuell') {
        diff.conflicts.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
          oldWert: existingWert,
          oldQuelle: existingQuelle,
          reason: 'Feld wurde manuell korrigiert',
        });
        continue;
      }

      // Both have values — check authority
      const authority = getFieldAuthority(candidate.fieldPath);
      const existingSourceType = inferSourceType(existingQuelle);
      const existingRank = authority.indexOf(existingSourceType);
      const newRank = authority.indexOf(candidate.segmentType);
      const existingAuth = existingRank === -1 ? 999 : existingRank;
      const newAuth = newRank === -1 ? 999 : newRank;

      if (newAuth < existingAuth) {
        // New source has higher authority — suggest update
        diff.updatedFields.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
          oldWert: existingWert,
          oldQuelle: existingQuelle,
          reason: `${candidate.segmentType} hat höhere Autorität als ${existingSourceType}`,
        });
      } else if (newAuth === existingAuth) {
        // Equal authority — conflict, user decides
        diff.conflicts.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
          oldWert: existingWert,
          oldQuelle: existingQuelle,
          reason: 'Gleiche Autoritätsstufe, unterschiedliche Werte',
        });
      }
      // else: existing has higher authority — skip silently
    } else {
      // Field doesn't exist in result or is not a SourcedValue — treat as new
      if (candidate.wert !== null && candidate.wert !== undefined && candidate.wert !== '') {
        diff.newFields.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
        });
      }
    }
  }

  logger.info('Merge-Diff berechnet', {
    newFields: diff.newFields.length,
    updatedFields: diff.updatedFields.length,
    conflicts: diff.conflicts.length,
    newForderungen: diff.newForderungen.length,
    updatedForderungen: diff.updatedForderungen.length,
  });

  return diff;
}

/**
 * Apply accepted merge changes to an ExtractionResult.
 * Returns the modified result (mutates in place).
 */
export function applyMergeDiff(
  result: ExtractionResult,
  diff: MergeDiff,
  accepted: Set<string>,
): ExtractionResult {
  const allChanges = [...diff.newFields, ...diff.updatedFields, ...diff.conflicts];

  for (const change of allChanges) {
    if (!accepted.has(change.path)) continue;

    const parts = change.path.split('.');
    let obj: Record<string, unknown> = result as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') {
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    const leafKey = parts[parts.length - 1];
    const field = obj[leafKey] as Record<string, unknown> | undefined;
    if (field && typeof field === 'object') {
      field.wert = change.wert;
      field.quelle = change.quelle;
      field.verifiziert = false;
      delete field.pruefstatus; // Reset — it's a fresh extraction, not manually set
    } else {
      obj[leafKey] = { wert: change.wert, quelle: change.quelle, verifiziert: false };
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/__tests__/documentMerge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/documentMerge.ts backend/src/services/__tests__/documentMerge.test.ts
git commit -m "feat: document merge service — diff + apply with authority resolution"
```

---

### Task 4: Documents API Route

**Files:**
- Create: `backend/src/routes/documents.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Create `backend/src/routes/documents.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { uploadMiddleware, validatePdfBuffer } from '../middleware/upload';
import { getDb } from '../db/database';
import { readResultJson, writeResultJson } from '../db/resultJson';
import { config } from '../config';
import { logger } from '../utils/logger';
import { classifySegmentSourceType } from '../utils/documentAnalyzer';
import { executeFieldPack } from '../utils/scalarPackExtractor';
import { getPacksForDebtorType, SCALAR_PACKS } from '../utils/fieldPacks';
import { extractAnchor } from '../utils/anchorExtractor';
import { computeMergeDiff, applyMergeDiff } from '../services/documentMerge';
import { computeExtractionStats } from '../utils/computeStats';
import { extractTextPerPage } from '../utils/pdfProcessor';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult, ExtractionCandidate, DocumentInfo, SegmentSourceType } from '../types/extraction';

const router = Router();

/**
 * Helper: resolve PDF directory for an extraction.
 */
function pdfDir(extractionId: number): string {
  const base = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
  return path.join(base, String(extractionId));
}

/**
 * Helper: get next doc_index for an extraction.
 */
function nextDocIndex(extractionId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(doc_index) as maxIdx FROM documents WHERE extraction_id = ?'
  ).get(extractionId) as { maxIdx: number | null } | undefined;
  return (row?.maxIdx ?? -1) + 1;
}

// ─── 1. Upload + Classify ───

router.post(
  '/:extractionId/documents',
  authMiddleware,
  (req: Request, res: Response, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const extractionId = parseInt(req.params['extractionId'] ?? '', 10);
    if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

    if (!req.file) { res.status(400).json({ error: 'Keine PDF-Datei hochgeladen' }); return; }

    try {
      validatePdfBuffer(req.file.buffer);
    } catch {
      res.status(400).json({ error: 'Datei ist kein gültiges PDF.' }); return;
    }

    // Verify extraction exists and belongs to user
    const db = getDb();
    const isAdmin = req.user!.role === 'admin';
    const extraction = db.prepare(
      isAdmin
        ? 'SELECT id, status, result_json FROM extractions WHERE id = ?'
        : 'SELECT id, status, result_json FROM extractions WHERE id = ? AND user_id = ?'
    ).get(...(isAdmin ? [extractionId] : [extractionId, userId])) as { id: number; status: string; result_json: string | null } | undefined;

    if (!extraction) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }
    if (extraction.status !== 'completed') { res.status(400).json({ error: 'Nur abgeschlossene Extraktionen können ergänzt werden' }); return; }

    // Duplicate check by hash
    const pdfHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const existingDoc = db.prepare(
      'SELECT id FROM documents WHERE extraction_id = ? AND pdf_hash = ?'
    ).get(extractionId, pdfHash) as { id: number } | undefined;

    if (existingDoc) {
      res.status(409).json({ error: 'Dieses Dokument wurde bereits hinzugefügt.' }); return;
    }

    // Extract page texts for classification
    const pageTexts = await extractTextPerPage(req.file.buffer);
    const pageCount = pageTexts.length;

    // Classify: build a pseudo-segment from all pages and classify
    const combinedText = pageTexts.join(' ').slice(0, 2000);
    const segment = { type: '', pages: Array.from({ length: pageCount }, (_, i) => i + 1), description: combinedText };
    const sourceType = classifySegmentSourceType(segment);

    // Store PDF
    const docIndex = nextDocIndex(extractionId);
    const dir = pdfDir(extractionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const pdfFilename = `${docIndex}_${sourceType}.pdf`;
    fs.writeFileSync(path.join(dir, pdfFilename), req.file.buffer);

    // Insert document record
    const insertResult = db.prepare(`
      INSERT INTO documents (extraction_id, doc_index, source_type, original_filename, page_count, pdf_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(extractionId, docIndex, sourceType, req.file.originalname, pageCount, pdfHash);
    const docId = Number(insertResult.lastInsertRowid);

    // Debtor name mismatch warning
    let warning: string | null = null;
    if (extraction.result_json) {
      const existingResult = readResultJson<ExtractionResult>(extraction.result_json);
      const existingName = existingResult?.schuldner?.name?.wert || existingResult?.schuldner?.firma?.wert;
      if (existingName && combinedText.length > 100) {
        const nameStr = String(existingName);
        if (!combinedText.toLowerCase().includes(nameStr.toLowerCase().slice(0, 6))) {
          warning = `Schuldnername "${nameStr}" nicht im Dokument gefunden. Prüfen Sie, ob das Dokument zur richtigen Akte gehört.`;
        }
      }
    }

    logger.info('Dokument hochgeladen und klassifiziert', { extractionId, docId, docIndex, sourceType, pageCount });

    // Audit log
    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(userId, 'document_upload', JSON.stringify({ extractionId, docId, sourceType, filename: req.file.originalname }), req.ip);

    res.json({ docId, docIndex, sourceType, pageCount, filename: req.file.originalname, warning });
  }
);

// ─── 2. Extract + Diff ───

router.post('/:extractionId/documents/:docId/extract', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const extractionId = parseInt(req.params['extractionId'] ?? '', 10);
  const docId = parseInt(req.params['docId'] ?? '', 10);
  if (isNaN(extractionId) || isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const isAdmin = req.user!.role === 'admin';

  // Load extraction
  const extraction = db.prepare(
    isAdmin
      ? 'SELECT id, result_json FROM extractions WHERE id = ? AND status = ?'
      : 'SELECT id, result_json FROM extractions WHERE id = ? AND user_id = ? AND status = ?'
  ).get(...(isAdmin ? [extractionId, 'completed'] : [extractionId, userId, 'completed'])) as { id: number; result_json: string | null } | undefined;

  if (!extraction || !extraction.result_json) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  // Load document
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
    .get(docId, extractionId) as DocumentInfo | undefined;
  if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  // Allow source type override
  const sourceType = (req.body?.sourceType as SegmentSourceType) || doc.sourceType as SegmentSourceType;

  // Read PDF and extract text
  const dir = pdfDir(extractionId);
  const pdfFilename = `${doc.docIndex}_${doc.sourceType}.pdf`;
  const pdfPath = path.join(dir, pdfFilename);
  if (!fs.existsSync(pdfPath)) { res.status(404).json({ error: 'PDF-Datei nicht gefunden' }); return; }

  const pdfBuffer = fs.readFileSync(pdfPath);
  const pageTexts = await extractTextPerPage(pdfBuffer);
  const pages = Array.from({ length: pageTexts.length }, (_, i) => i + 1);

  // Find matching field packs for this source type
  const matchingPacks = SCALAR_PACKS.filter(p => p.segmentTypes.includes(sourceType));

  if (matchingPacks.length === 0) {
    // Fallback: run all packs on this document
    logger.warn('Kein passendes Feldpaket für Dokumenttyp', { sourceType });
  }

  const packsToRun = matchingPacks.length > 0 ? matchingPacks : SCALAR_PACKS;

  // Build a minimal anchor from existing result
  const existingResult = readResultJson<ExtractionResult>(extraction.result_json)!;
  const anchor = {
    aktenzeichen: existingResult.verfahrensdaten?.aktenzeichen?.wert as string | null ?? null,
    gericht: existingResult.verfahrensdaten?.gericht?.wert as string | null ?? null,
    beschlussdatum: existingResult.verfahrensdaten?.beschlussdatum?.wert as string | null ?? null,
    antragsdatum: existingResult.verfahrensdaten?.antragsdatum?.wert as string | null ?? null,
    debtor_canonical_name: (existingResult.schuldner?.name?.wert || existingResult.schuldner?.firma?.wert) as string | null ?? null,
    debtor_rechtsform: existingResult.schuldner?.rechtsform?.wert as string | null ?? null,
    debtor_type: 'natuerliche_person' as const,
    applicant_canonical_name: existingResult.antragsteller?.name?.wert as string | null ?? null,
    gutachter_name: existingResult.gutachterbestellung?.gutachter_name?.wert as string | null ?? null,
  };

  // Run field packs
  const allCandidates: ExtractionCandidate[] = [];
  for (const pack of packsToRun) {
    const candidates = await executeFieldPack(
      pack, pageTexts, pages, [sourceType], anchor, null,
    );
    // Prefix quellen with document name
    for (const c of candidates) {
      if (c.quelle && !c.quelle.includes(doc.originalFilename)) {
        c.quelle = c.quelle.replace(/^Seite/i, `${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)}, Seite`);
      }
    }
    allCandidates.push(...candidates);
  }

  // Compute diff
  const diff = computeMergeDiff(existingResult, allCandidates);

  logger.info('Dokument-Extraktion + Diff abgeschlossen', {
    extractionId, docId, sourceType,
    candidates: allCandidates.length,
    newFields: diff.newFields.length,
    updatedFields: diff.updatedFields.length,
    conflicts: diff.conflicts.length,
  });

  res.json(diff);
});

// ─── 3. Apply ───

router.post('/:extractionId/documents/:docId/apply', authMiddleware, (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const extractionId = parseInt(req.params['extractionId'] ?? '', 10);
  const docId = parseInt(req.params['docId'] ?? '', 10);
  if (isNaN(extractionId) || isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const isAdmin = req.user!.role === 'admin';

  const extraction = db.prepare(
    isAdmin
      ? 'SELECT id, result_json FROM extractions WHERE id = ? AND status = ?'
      : 'SELECT id, result_json FROM extractions WHERE id = ? AND user_id = ? AND status = ?'
  ).get(...(isAdmin ? [extractionId, 'completed'] : [extractionId, userId, 'completed'])) as { id: number; result_json: string | null } | undefined;

  if (!extraction || !extraction.result_json) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  const { acceptAll, accept, reject: rejectPaths } = req.body as {
    acceptAll?: boolean;
    accept?: string[];
    reject?: string[];
  };

  // Reconstruct diff from the stored extraction (caller must send the diff or we re-derive accepted paths)
  const result = readResultJson<ExtractionResult>(extraction.result_json)!;

  // Build accepted set
  const accepted = new Set<string>();
  if (acceptAll) {
    // Accept all — but we need the diff. For now, apply all fields from accept array or all
    // The frontend sends the specific paths to accept
    if (accept) {
      for (const p of accept) accepted.add(p);
    }
  } else if (accept) {
    for (const p of accept) accepted.add(p);
  }

  if (accepted.size === 0 && !acceptAll) {
    res.status(400).json({ error: 'Keine Änderungen zum Anwenden ausgewählt' }); return;
  }

  // Re-read the diff that was cached in the response (client sends back the fields to apply)
  // Apply changes directly from the accept list with values from the request body
  const changes = req.body.changes as Array<{ path: string; wert: unknown; quelle: string }> | undefined;
  if (changes) {
    for (const change of changes) {
      if (!acceptAll && !accepted.has(change.path)) continue;

      const parts = change.path.split('.');
      let obj: Record<string, unknown> = result as unknown as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      const leafKey = parts[parts.length - 1];
      const field = obj[leafKey] as Record<string, unknown> | undefined;
      if (field && typeof field === 'object') {
        field.wert = change.wert;
        field.quelle = change.quelle;
        field.verifiziert = false;
        delete field.pruefstatus;
      } else {
        obj[leafKey] = { wert: change.wert, quelle: change.quelle, verifiziert: false };
      }
    }
  }

  // Recompute stats and save
  const stats = computeExtractionStats(result);
  db.prepare(`
    UPDATE extractions SET result_json = ?, stats_found = ?, stats_missing = ?, stats_letters_ready = ?
    WHERE id = ?
  `).run(writeResultJson(result), stats.found, stats.missing, stats.lettersReady, extractionId);

  // Audit log
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'document_merge', JSON.stringify({
    extractionId, docId,
    fieldsApplied: changes?.length ?? 0,
  }), req.ip);

  logger.info('Dokument-Merge angewendet', {
    extractionId, docId,
    fieldsApplied: changes?.length ?? 0,
    statsFound: stats.found,
  });

  res.json({ statsFound: stats.found, statsMissing: stats.missing, statsLettersReady: stats.lettersReady });
});

// ─── List documents for an extraction ───

router.get('/:extractionId/documents', authMiddleware, (req: Request, res: Response): void => {
  const extractionId = parseInt(req.params['extractionId'] ?? '', 10);
  if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const docs = db.prepare('SELECT * FROM documents WHERE extraction_id = ? ORDER BY doc_index')
    .all(extractionId) as DocumentInfo[];

  res.json(docs);
});

// ─── Serve a specific document's PDF ───

router.get('/:extractionId/documents/:docId/pdf', authMiddleware, (req: Request, res: Response): void => {
  const extractionId = parseInt(req.params['extractionId'] ?? '', 10);
  const docId = parseInt(req.params['docId'] ?? '', 10);
  if (isNaN(extractionId) || isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
    .get(docId, extractionId) as DocumentInfo | undefined;
  if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  const dir = pdfDir(extractionId);
  const pdfFilename = `${doc.docIndex}_${doc.sourceType}.pdf`;
  const pdfPath = path.join(dir, pdfFilename);
  if (!fs.existsSync(pdfPath)) { res.status(404).json({ error: 'PDF nicht verfügbar' }); return; }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.originalFilename)}"`);
  fs.createReadStream(pdfPath).pipe(res);
});

export default router;
```

- [ ] **Step 2: Register route in `backend/src/index.ts`**

Add import:
```typescript
import documentsRoutes from './routes/documents';
```

Add route (after the history route):
```typescript
app.use('/api/extractions', documentsRoutes);
```

Note: This shares the `/api/extractions` prefix with `fieldUpdateRoutes`. The paths don't conflict because fieldUpdate uses `PATCH /:id/fields` and documents uses `POST/GET /:extractionId/documents`.

- [ ] **Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/documents.ts backend/src/index.ts
git commit -m "feat: documents API — upload, classify, extract+diff, apply, list, serve PDF"
```

---

### Task 5: Frontend — AddDocumentWizard + MergeSummary

**Files:**
- Create: `frontend/src/components/extraction/AddDocumentWizard.tsx`
- Create: `frontend/src/components/extraction/MergeSummary.tsx`

- [ ] **Step 1: Create `frontend/src/components/extraction/MergeSummary.tsx`**

```tsx
import { useState } from 'react';
import type { MergeDiff, MergeFieldChange } from '../../types/extraction';

interface MergeSummaryProps {
  diff: MergeDiff;
  onApply: (acceptedPaths: string[], changes: Array<{ path: string; wert: unknown; quelle: string }>) => void;
  onCancel: () => void;
  applying: boolean;
}

function FieldRow({ change, checked, onToggle, variant }: {
  change: MergeFieldChange;
  checked: boolean;
  onToggle: () => void;
  variant: 'new' | 'updated' | 'conflict';
}) {
  const colors = {
    new: 'border-green-800/40 bg-green-900/10',
    updated: 'border-blue-800/40 bg-blue-900/10',
    conflict: 'border-red-800/40 bg-red-900/10',
  };

  return (
    <label className={`flex items-start gap-2 p-2 rounded border ${colors[variant]} cursor-pointer`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 accent-accent" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-text-dim font-mono">{change.path}</div>
        {change.oldWert !== undefined && (
          <div className="text-[11px] text-red-400 line-through truncate">{String(change.oldWert)}</div>
        )}
        <div className="text-[11px] text-text truncate">{String(change.wert)}</div>
        <div className="text-[9px] text-text-muted mt-0.5">{change.quelle}</div>
        {change.reason && <div className="text-[9px] text-text-dim italic mt-0.5">{change.reason}</div>}
      </div>
    </label>
  );
}

export function MergeSummary({ diff, onApply, onCancel, applying }: MergeSummaryProps) {
  const allChanges = [...diff.newFields, ...diff.updatedFields, ...diff.conflicts];
  const [accepted, setAccepted] = useState<Set<string>>(() => {
    // Default: accept new + updated, conflicts unchecked
    const set = new Set<string>();
    for (const f of diff.newFields) set.add(f.path);
    for (const f of diff.updatedFields) set.add(f.path);
    return set;
  });

  const toggle = (path: string) => {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const hasUnresolvedConflicts = diff.conflicts.some(c => !accepted.has(c.path)) && diff.conflicts.length > 0;

  const handleApply = () => {
    const paths = [...accepted];
    const changes = allChanges
      .filter(c => accepted.has(c.path))
      .map(c => ({ path: c.path, wert: c.wert, quelle: c.quelle }));
    onApply(paths, changes);
  };

  const totalChanges = allChanges.length + diff.newForderungen.length + diff.updatedForderungen.length;

  if (totalChanges === 0) {
    return (
      <div className="text-center py-8">
        <div className="text-2xl mb-2">✓</div>
        <p className="text-[11px] text-text-muted">Keine neuen Daten gefunden — das Dokument enthält keine zusätzlichen Informationen.</p>
        <button onClick={onCancel} className="mt-4 px-4 py-1.5 text-[11px] text-text-muted hover:text-text">
          Schließen
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {diff.newFields.length > 0 && (
        <div>
          <h4 className="text-[10px] text-green-400 font-semibold mb-1.5">{diff.newFields.length} neue Felder</h4>
          <div className="space-y-1">
            {diff.newFields.map(f => (
              <FieldRow key={f.path} change={f} checked={accepted.has(f.path)} onToggle={() => toggle(f.path)} variant="new" />
            ))}
          </div>
        </div>
      )}

      {diff.updatedFields.length > 0 && (
        <div>
          <h4 className="text-[10px] text-blue-400 font-semibold mb-1.5">{diff.updatedFields.length} aktualisierte Felder</h4>
          <div className="space-y-1">
            {diff.updatedFields.map(f => (
              <FieldRow key={f.path} change={f} checked={accepted.has(f.path)} onToggle={() => toggle(f.path)} variant="updated" />
            ))}
          </div>
        </div>
      )}

      {diff.conflicts.length > 0 && (
        <div>
          <h4 className="text-[10px] text-red-400 font-semibold mb-1.5">{diff.conflicts.length} Konflikte — bitte entscheiden</h4>
          <div className="space-y-1">
            {diff.conflicts.map(f => (
              <FieldRow key={f.path} change={f} checked={accepted.has(f.path)} onToggle={() => toggle(f.path)} variant="conflict" />
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleApply}
          disabled={applying}
          className="flex-1 py-2 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50"
        >
          {applying ? 'Wird angewendet…' : `${accepted.size} Änderungen übernehmen`}
        </button>
        <button onClick={onCancel} disabled={applying} className="px-4 py-2 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
          Abbrechen
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `frontend/src/components/extraction/AddDocumentWizard.tsx`**

```tsx
import { useState, useCallback } from 'react';
import { apiClient } from '../../api/client';
import { MergeSummary } from './MergeSummary';
import type { MergeDiff } from '../../types/extraction';

interface AddDocumentWizardProps {
  extractionId: number;
  onClose: () => void;
  onMerged: () => void; // callback to refresh extraction data
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  beschluss: 'Gerichtsbeschluss',
  insolvenzantrag: 'Insolvenzantrag',
  pzu: 'Postzustellungsurkunde (PZU)',
  handelsregister: 'Handelsregisterauszug',
  meldeauskunft: 'Meldeauskunft',
  fragebogen: 'Fragebogen / Selbstauskunft',
  grundbuch: 'Grundbuchauszug',
  gerichtsvollzieher: 'Gerichtsvollzieher-Auskunft',
  vollstreckungsportal: 'Vollstreckungsportal',
  forderungstabelle: 'Forderungsanmeldung',
  vermoegensverzeichnis: 'Vermögensverzeichnis',
  gutachterbestellung: 'Gutachterbestellung',
  sonstiges: 'Sonstiges Dokument',
};

const STEP_LABELS = ['Upload', 'Klassifizierung', 'Extraktion', 'Änderungen prüfen'];

export function AddDocumentWizard({ extractionId, onClose, onMerged }: AddDocumentWizardProps) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  // Upload result
  const [docId, setDocId] = useState<number | null>(null);
  const [sourceType, setSourceType] = useState('sonstiges');
  const [pageCount, setPageCount] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);

  // Diff result
  const [diff, setDiff] = useState<MergeDiff | null>(null);

  const handleUpload = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const { data } = await apiClient.post(`/extractions/${extractionId}/documents`, formData);
      setDocId(data.docId);
      setSourceType(data.sourceType);
      setPageCount(data.pageCount);
      setWarning(data.warning);
      setStep(2);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Upload fehlgeschlagen');
    } finally {
      setUploading(false);
    }
  }, [file, extractionId]);

  const handleExtract = useCallback(async () => {
    if (!docId) return;
    setExtracting(true);
    setError('');
    try {
      const { data } = await apiClient.post(
        `/extractions/${extractionId}/documents/${docId}/extract`,
        { sourceType }
      );
      setDiff(data as MergeDiff);
      setStep(4);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Extraktion fehlgeschlagen');
    } finally {
      setExtracting(false);
    }
  }, [docId, extractionId, sourceType]);

  const handleApply = useCallback(async (acceptedPaths: string[], changes: Array<{ path: string; wert: unknown; quelle: string }>) => {
    if (!docId) return;
    setApplying(true);
    setError('');
    try {
      await apiClient.post(`/extractions/${extractionId}/documents/${docId}/apply`, {
        accept: acceptedPaths,
        changes,
      });
      onMerged();
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Merge fehlgeschlagen');
    } finally {
      setApplying(false);
    }
  }, [docId, extractionId, onMerged, onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-1 p-3 border-b border-border">
          {STEP_LABELS.map((label, i) => (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-border mx-1">›</span>}
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                i + 1 === step ? 'bg-accent text-white font-bold' :
                i + 1 < step ? 'bg-accent/20 text-accent' : 'text-text-dim'
              }`}>{i + 1}</span>
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

          {/* Step 1: Upload */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-[11px] text-text-muted">Zusätzliches Dokument hochladen (z.B. Grundbuchauszug, Meldeauskunft, Forderungsanmeldung)</p>
              <div
                onClick={() => document.getElementById('doc-upload-input')?.click()}
                className="border border-dashed border-border/90 rounded-lg py-10 px-6 text-center cursor-pointer hover:border-accent/30 hover:bg-accent/[0.04] transition-all"
              >
                <div className="text-2xl mb-2 opacity-60">{file ? '📄' : '📁'}</div>
                {file ? (
                  <>
                    <div className="text-[12px] text-text font-medium truncate">{file.name}</div>
                    <div className="text-[10px] text-text-muted mt-1">{(file.size / 1024).toFixed(0)} KB</div>
                  </>
                ) : (
                  <div className="text-[12px] text-text-dim">PDF ablegen oder klicken</div>
                )}
              </div>
              <input
                id="doc-upload-input"
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={e => { if (e.target.files?.[0]) setFile(e.target.files[0]); }}
              />
            </div>
          )}

          {/* Step 2: Classification */}
          {step === 2 && (
            <div className="space-y-3">
              {warning && (
                <div className="p-2 bg-amber-900/20 border border-amber-800/40 rounded text-[11px] text-amber-300">
                  ⚠ {warning}
                </div>
              )}
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Dokumenttyp</label>
                <select
                  value={sourceType}
                  onChange={e => setSourceType(e.target.value)}
                  className="w-full px-2 py-2 bg-bg border border-border rounded text-[12px] text-text"
                >
                  {Object.entries(SOURCE_TYPE_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-bg border border-border/60 rounded px-3 py-2">
                  <div className="text-[9px] text-text-dim">Seiten</div>
                  <div className="text-[12px] text-text">{pageCount}</div>
                </div>
                <div className="bg-bg border border-border/60 rounded px-3 py-2">
                  <div className="text-[9px] text-text-dim">Datei</div>
                  <div className="text-[12px] text-text truncate">{file?.name}</div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Extracting */}
          {step === 3 && (
            <div className="text-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-[11px] text-text-muted">Dokument wird analysiert…</p>
            </div>
          )}

          {/* Step 4: Merge Summary */}
          {step === 4 && diff && (
            <MergeSummary diff={diff} onApply={handleApply} onCancel={onClose} applying={applying} />
          )}
        </div>

        {/* Footer */}
        {step < 3 && (
          <div className="flex justify-between p-3 border-t border-border">
            <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
              className="px-4 py-1.5 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
              ← Zurück
            </button>
            {step === 1 && (
              <button onClick={handleUpload} disabled={!file || uploading}
                className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
                {uploading ? 'Lädt hoch…' : 'Hochladen'}
              </button>
            )}
            {step === 2 && (
              <button onClick={() => { setStep(3); handleExtract(); }} disabled={extracting}
                className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
                Analysieren →
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify frontend build**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/extraction/AddDocumentWizard.tsx frontend/src/components/extraction/MergeSummary.tsx
git commit -m "feat: AddDocumentWizard + MergeSummary frontend components"
```

---

### Task 6: Wire Up in DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Read `DashboardPage.tsx` to find the extraction detail header area (around line 208-230)**

- [ ] **Step 2: Add state and import**

At the top:
```typescript
import { AddDocumentWizard } from '../components/extraction/AddDocumentWizard';
```

Add state:
```typescript
const [showAddDoc, setShowAddDoc] = useState(false);
```

- [ ] **Step 3: Add "Dokument hinzufügen" button**

In the header bar of the extraction detail view (near the "NEUE ANALYSE" and "EXPORTIEREN" buttons), add:

```tsx
{extractionId && (
  <button
    onClick={() => setShowAddDoc(true)}
    className="px-2 py-0.5 border border-border rounded-md hover:border-accent hover:text-accent transition-colors font-mono text-[10px]"
  >
    + DOKUMENT
  </button>
)}
```

- [ ] **Step 4: Add the wizard modal**

After the existing modals (export dialog, import dialog), add:

```tsx
{showAddDoc && extractionId && (
  <AddDocumentWizard
    extractionId={extractionId}
    onClose={() => setShowAddDoc(false)}
    onMerged={() => {
      // Reload extraction data
      if (extractionId) loadFromHistory(extractionId);
      setShowAddDoc(false);
    }}
  />
)}
```

- [ ] **Step 5: Verify build**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
git commit -m "feat: wire AddDocumentWizard into DashboardPage"
```

---

### Task 7: Multi-Document PDF Viewer

**Files:**
- Modify: `frontend/src/components/pdf/PdfViewer.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Update PdfViewer to accept multiple files**

Change the interface:
```typescript
interface PdfViewerProps {
  files: Array<{ file: File; label: string }>;
  children: React.ReactNode;
}
```

Update the component to:
1. Create Object URLs for all files
2. Render multiple `<Document>` components in sequence
3. Add a separator between documents showing the label
4. Track total pages across all documents for page numbering
5. Maintain backward compat by also accepting a single `file` prop

Key changes:
- The `useEffect` that creates object URLs now loops over `files` array
- Page numbering is global (Document 1 pages 1-30, separator, Document 2 pages 31-32)
- Separators render as styled divs between Document components: `"--- {label} ({pageCount} Seiten) ---"`
- The `goToPage` and `goToPageAndHighlight` functions work with global page numbers

- [ ] **Step 2: Update DashboardPage to pass multiple files**

When loading from history, also fetch the document list:
```typescript
// After loading extraction, fetch documents
const docsRes = await apiClient.get(`/extractions/${id}/documents`);
const docs = docsRes.data as DocumentInfo[];
```

For each document, fetch its PDF and build the files array:
```typescript
const pdfFiles: Array<{ file: File; label: string }> = [];
for (const doc of docs) {
  try {
    const pdfRes = await fetch(`${API_BASE}/extractions/${id}/documents/${doc.id}/pdf`, { headers: authHeaders });
    if (pdfRes.ok) {
      const blob = await pdfRes.blob();
      pdfFiles.push({
        file: new File([blob], doc.originalFilename, { type: 'application/pdf' }),
        label: `${SOURCE_TYPE_LABELS[doc.sourceType] || doc.sourceType} (${doc.originalFilename})`,
      });
    }
  } catch { /* skip unavailable PDFs */ }
}
```

Pass to PdfViewer:
```tsx
<PdfViewer files={pdfFiles}>
```

- [ ] **Step 3: Verify build**

Run: `cd frontend && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/pdf/PdfViewer.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat: multi-document PDF viewer with concatenated view and separators"
```

---

### Task 8: Integration Test

- [ ] **Step 1: Run all backend tests**

```bash
cd backend && npx vitest run
```
Expected: all pass

- [ ] **Step 2: Run frontend build**

```bash
cd frontend && npm run build
```
Expected: clean build

- [ ] **Step 3: Manual test flow**

1. Start dev servers: `cd backend && npm run dev` + `cd frontend && npm run dev`
2. Upload a PDF, wait for extraction to complete
3. Click "DOKUMENT" button on the completed extraction
4. Upload a small supplementary PDF (e.g. a 2-page Grundbuchauszug)
5. Verify classification screen shows correct document type
6. Click "Analysieren" — verify extraction runs
7. Verify merge summary shows new/updated fields
8. Check/uncheck some fields, click "Übernehmen"
9. Verify extraction result updated with merged data
10. Verify PDF viewer shows both documents with separator

- [ ] **Step 4: Commit any fixes**

```bash
git commit -m "fix: integration test fixes for add-document feature"
```

---

## Architecture Decision Record

**Why separate files, not appended PDF?** Keeps document boundaries clean, enables meaningful quelle references ("Grundbuchauszug, Seite 2"), allows deleting wrong uploads, simplifies the viewer (multiple Document components vs page splicing).

**Why user confirms all changes?** Insolvency administrators are personally liable for Gutachten accuracy. Silent overwrites undermine trust and auditability, even when the authority matrix is correct.

**Why field packs for extraction?** The infrastructure already exists. A Grundbuchauszug triggers the ermittlungsergebnisse pack. A Meldeauskunft triggers schuldner_personal. Reuses existing prompts and authority logic without new code.

**Why not re-run full extraction?** Would overwrite manual corrections. The incremental approach preserves user work and only adds new data.
