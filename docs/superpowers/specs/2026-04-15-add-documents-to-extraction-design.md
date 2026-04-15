# Add Documents to Existing Extraction — Design Spec

## Problem

Insolvency case files arrive incrementally. The initial Gerichtsakte is uploaded and extracted, then over days/weeks additional documents arrive: Grundbuchauszug, Meldeauskunft, Forderungsanmeldungen, GV-Auskunft, KBA-Auskunft, etc. Currently, each extraction is tied to a single PDF — there's no way to add new documents without creating a separate extraction and manually cross-referencing.

## Use Cases

- **Primary (B):** Client receives a separate document (e.g. Grundbuchauszug response) after initial extraction. Wants to add it to the same case, merging new data into existing fields.
- **Secondary (A):** Gerichtsakte arrives in batches. New pages supplement the original.

## Architecture

A new document upload triggers a 4-step flow:

1. **Upload** — PDF stored as separate file in `data/pdfs/{extractionId}/` directory, linked via `documents` table
2. **Classify** — detect document type (Grundbuchauszug, Forderungsanmeldung, etc.) via `classifySegmentSourceType()`
3. **Extract** — run the matching field pack(s) on just this document's pages, producing `ExtractionCandidate[]`
4. **Review & Merge** — diff candidates against existing result, show summary (new/updated/conflict), user confirms before anything changes

Nothing changes in `result_json` until the user clicks "Übernehmen".

## Data Model

### New `documents` table

```sql
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id INTEGER NOT NULL REFERENCES extractions(id),
  doc_index INTEGER NOT NULL,         -- 0 = original Gerichtsakte
  source_type TEXT NOT NULL,          -- 'gerichtsakte', 'grundbuchauszug', 'meldeauskunft', etc.
  original_filename TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  pdf_hash TEXT,                      -- SHA-256 for duplicate detection
  uploaded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(extraction_id, doc_index)
);
```

### Migration

- Create `documents` table.
- Backfill: for each existing extraction, insert a row with `doc_index=0`, `source_type='gerichtsakte'`, `original_filename` from `extractions.filename`, `page_count` from stored PDF.
- Move PDF files: `data/pdfs/{id}.pdf` → `data/pdfs/{id}/0_gerichtsakte.pdf`.
- Update `GET /:id/pdf` endpoint to serve from new path (backward compatible: try new path first, fall back to old).

### PDF Storage

```
data/pdfs/
  63/
    0_gerichtsakte.pdf
    1_grundbuchauszug.pdf
    2_meldeauskunft.pdf
```

Each document is a separate file. Never appended into a single PDF.

### Quelle Format

New documents use qualified references: `"Grundbuchauszug, Seite 2"` instead of `"Seite 79"`.

Existing quellen from the original Gerichtsakte stay as `"Seite X, ..."` in Phase 1. Phase 2 migrates them to `"Gerichtsakte, Seite X, ..."`.

## API Endpoints

### 1. Upload + Classify

`POST /api/extractions/:id/documents`

Accepts: multipart PDF upload.

Behavior:
- Validate PDF (magic bytes, size limit)
- Compute SHA-256 hash → check for duplicates in `documents` table for this extraction. If match: return 409 "Dieses Dokument wurde bereits hinzugefügt."
- Store PDF as `data/pdfs/{extractionId}/{docIndex}_{sourceType}.pdf`
- Extract page text, run `classifySegmentSourceType()` on content
- Compare extracted debtor name/Aktenzeichen against existing extraction. If mismatch: include warning in response (do not block).
- Insert row into `documents` table
- Return classification for user confirmation

```json
{
  "docId": 3,
  "docIndex": 2,
  "sourceType": "grundbuchauszug",
  "pageCount": 2,
  "filename": "Grundbuch_Antwort.pdf",
  "warning": null
}
```

User can correct `sourceType` before proceeding.

### 2. Extract + Diff

`POST /api/extractions/:id/documents/:docId/extract`

Accepts: optional `{ "sourceType": "meldeauskunft" }` to override classification.

Behavior:
- Read page texts from the document's PDF
- Run the matching field pack(s) for the source type → produces `ExtractionCandidate[]`
- For Forderungsanmeldung source type: run forderungenExtractor on the document's pages
- Load existing `result_json` from DB
- Diff each candidate against existing result:
  - **New field:** existing value is null/empty → categorize as "new"
  - **Updated field:** existing value differs, authority matrix says new source wins → categorize as "updated" with reason
  - **Conflict (manual):** existing field has `pruefstatus === 'manuell'` → always categorize as "conflict", never auto-resolve
  - **Conflict (equal authority):** both sources at same authority level, different values → categorize as "conflict"
  - **No change:** same value → skip
- For array fields (einzelforderungen): deduplicate by composite key (glaeubiger + betrag + titel). New entries → "newForderungen". Same glaeubiger but different betrag → "updatedForderungen".

```json
{
  "newFields": [
    { "path": "ermittlungsergebnisse.grundbuch.ergebnis", "wert": "Grundbesitz vorhanden", "quelle": "Grundbuchauszug, Seite 1" }
  ],
  "updatedFields": [
    { "path": "schuldner.aktuelle_adresse", "oldWert": "Hauptstr. 1", "newWert": "Hauptstraße 1, 12345 Berlin", "oldQuelle": "Seite 5, Antrag", "newQuelle": "Meldeauskunft, Seite 1", "reason": "Meldeauskunft hat höhere Autorität" }
  ],
  "conflicts": [
    { "path": "schuldner.telefon", "oldWert": "0651-123", "newWert": "0651-456", "oldQuelle": "Seite 8, Antrag", "newQuelle": "Meldeauskunft, Seite 1", "reason": "Feld wurde manuell korrigiert" }
  ],
  "newForderungen": [
    { "index": 0, "glaeubiger": "Finanzamt Trier", "betrag": 4500.00, "quelle": "Forderungsanmeldung, Seite 1" }
  ],
  "updatedForderungen": [
    { "existingIndex": 3, "glaeubiger": "Sparkasse", "oldBetrag": 12450, "newBetrag": 14200, "quelle": "Forderungsanmeldung, Seite 2" }
  ]
}
```

### 3. Apply

`POST /api/extractions/:id/documents/:docId/apply`

Accepts:
```json
{
  "acceptAll": true
}
```
or granular:
```json
{
  "accept": ["ermittlungsergebnisse.grundbuch.ergebnis", "schuldner.aktuelle_adresse"],
  "reject": ["schuldner.telefon"],
  "forderungen": { "add": [0], "update": [0] }
}
```

Behavior:
- Load existing `result_json`
- Apply accepted changes: set `wert`, `quelle`, `verifiziert: false`, `pruefstatus: undefined` (reset to unverified since it's a new extraction)
- For accepted forderungen: append new entries, update existing entries by index
- Write updated `result_json` to DB
- Recompute stats (found/missing/lettersReady) and update extraction row
- Audit log: record which fields were updated from which document
- Update `documents` row with `extracted_at` timestamp
- Return updated stats

## Merge Rules

### Authority Matrix (existing)
The field authority matrix (`fieldAuthority.ts`) determines which source type wins per field. Used to auto-suggest "updated" vs "conflict".

### Manual Correction Protection
Fields with `pruefstatus === 'manuell'` are NEVER auto-resolved. They always surface as conflicts for user decision. This is non-negotiable — the user explicitly corrected this value.

### Forderungen Deduplication
Composite key: `glaeubiger` (normalized lowercase) + `betrag` + `titel`. If all three match: skip (duplicate). If glaeubiger matches but betrag differs: surface as "updatedForderung" for user confirmation.

## Frontend

### Entry Point
"Dokument hinzufügen" button in the extraction detail header bar (next to filename). Only visible on completed extractions with an `extractionId`.

### Modal — 4 Steps

**Step 1: Upload**
- Dropzone (reuse PdfUploader component)
- Accepts single PDF

**Step 2: Klassifizierung**
- Shows detected type: "Erkannt als: Grundbuchauszug"
- Dropdown to correct classification
- Warning banner if debtor name mismatch detected
- "Weiter" button

**Step 3: Extraktion**
- Spinner with progress message
- Runs the field pack extraction

**Step 4: Änderungen prüfen**
- Green section: "N neue Felder" — expandable, each with checkbox (default: checked)
- Blue section: "N aktualisierte Felder" — shows old → new value + authority reason, each with checkbox (default: checked)
- Red section: "N Konflikte" — shows both values, user must pick one (no default)
- Orange section: Forderungen diff — new entries + updated entries, each with checkbox
- "Übernehmen" button (disabled until all conflicts resolved)
- "Abbrechen" button — discards document extraction (keeps uploaded PDF for retry)

### After Apply
Modal closes. Extraction result refreshes with merged data. Toast notification: "Grundbuchauszug hinzugefügt — N Felder aktualisiert."

### PDF Viewer
**Concatenated view (default):** All documents rendered as one continuous scroll, with visual separators between documents showing document name and page range (e.g. "--- Grundbuchauszug (2 Seiten) ---").

**Document filter (Phase 2):** Dropdown above viewer to show only a specific document.

**Quelle navigation:** Clicking a quelle reference that includes a document name (e.g. "Grundbuchauszug, Seite 2") auto-scrolls to the correct position in the concatenated view.

## Duplicate & Safety Checks

- **Duplicate detection:** SHA-256 hash of uploaded PDF checked against existing documents for this extraction. Match → 409 error.
- **Debtor name mismatch:** Compare extracted name/Aktenzeichen from new document against existing extraction. Mismatch → warning banner (non-blocking).
- **OCR pipeline:** New documents may be scanned. OCR (Stage 0) runs independently on the new PDF. OCR caching works per-hash as before.

## Phase 1 (MVP)

- `documents` table migration + backfill existing extractions
- PDF storage restructure (`data/pdfs/{id}/` directory)
- 3 API endpoints (upload+classify, extract+diff, apply)
- Frontend modal (upload → classify → extract → review changes → apply)
- PDF viewer: concatenated view with separators
- Duplicate detection by PDF hash
- Debtor name mismatch warning
- Manual correction protection

## Phase 2 (Polish)

- Document filter dropdown in PDF viewer
- Retroactive quelle format migration ("Seite 5" → "Gerichtsakte, Seite 5")
- Delete individual documents from an extraction
- Document reordering
- Batch upload (multiple documents at once)

## Files Affected (Phase 1)

### Backend
- `backend/src/db/migrations/005_add_documents.sql` — new table + backfill
- `backend/src/routes/documents.ts` — new route file for 3 endpoints
- `backend/src/services/documentMerge.ts` — diff + merge logic
- `backend/src/routes/history.ts` — update PDF serving for new path structure
- `backend/src/services/extraction.ts` — update PDF save path for new extractions
- `backend/src/middleware/upload.ts` — reuse existing PDF validation

### Frontend
- `frontend/src/components/extraction/AddDocumentWizard.tsx` — new modal component
- `frontend/src/components/extraction/MergeSummary.tsx` — diff review screen
- `frontend/src/components/pdf/PdfViewer.tsx` — concatenated multi-doc view with separators
- `frontend/src/pages/DashboardPage.tsx` — add "Dokument hinzufügen" button

### Shared
- `shared/types/extraction.ts` — add `DocumentInfo` type
