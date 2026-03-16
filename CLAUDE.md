# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

InsolvenzAkte Extraktor — AI-powered tool for German insolvency law firms. Uploads court file PDFs, extracts structured data via Claude API (Haiku), verifies/corrects page references semantically, and checks readiness of 10 standard letter types. All UI and logs are in German.

## Development Commands

```bash
# Backend (from /backend)
npm run dev          # Start with tsx watch (hot-reload), port 3004
npm run build        # TypeScript compile to dist/
npm run test         # vitest run (one-shot)
npm run test:watch   # vitest (watch mode)
npm run verify -- --id=1              # Verify existing extraction from DB
npm run verify -- ../standardschreiben/Bankenanfrage.pdf  # Extract + verify PDF

# Frontend (from /frontend)
npm run dev          # Vite dev server on :3005, proxies /api → :3004
npm run build        # tsc -b && vite build

# Docker
docker compose up --build                         # Production
docker compose -f docker-compose.dev.yml up --build  # Dev with volume mounts
```

## Architecture

**Monorepo** with three packages: `backend/`, `frontend/`, `shared/`.

### Backend (Express + TypeScript, port 3004)
- **Entry**: `src/index.ts` — Express app, seeds admin user on first start
- **Config**: `src/config.ts` — Zod-validated env vars, exits on invalid config
- **Database**: SQLite via `better-sqlite3`, WAL mode. Migrations in `src/db/migrations/*.sql` run automatically on startup
- **Routes**: `src/routes/` — auth (JWT), extraction (PDF upload), history, generateLetter (DOCX from templates), fieldUpdate (manual corrections)

### Three-Stage Extraction Pipeline (`src/services/extraction.ts`)

```
PDF → pdfProcessor → pageTexts
                        ↓
          Stage 1: documentAnalyzer.ts (Haiku)
          Maps document structure: which pages = which document type
                        ↓ documentMap
          Stage 2: anthropic.ts (Haiku)
          Extracts all fields using document map as context
          Small PDFs (<100 pages): native PDF mode
          Large PDFs: 30-page chunks, merged after extraction
                        ↓ ExtractionResult
          Stage 3: semanticVerifier.ts (Haiku)
          Verifies + corrects fields against actual page texts
          Can: confirm, correct source, correct value, remove value
                        ↓ verified ExtractionResult
          letterChecklist.ts
          Validates 10 standard letter types
```

- **Stage 1 — Document Analysis** (`src/utils/documentAnalyzer.ts`): Haiku call that produces a text map of the document structure (e.g., "Seiten 1-3: Beschluss, Seiten 4-8: Insolvenzantrag"). This map feeds into both extraction and verification as context. Graceful degradation on failure.
- **Stage 2 — Extraction** (`src/services/anthropic.ts`): Uses `claude-haiku-4-5-20251001`, raw JSON prompt (no structured output API), retry with backoff on 429s, `jsonrepair` for malformed responses, Zod validation with `z.preprocess` coercion. Document map included as `STRUKTURÜBERSICHT` (orientation only, page numbers must come from actual content).
- **Stage 3 — Semantic Verification** (`src/utils/semanticVerifier.ts`): Collects all non-empty `{wert, quelle}` fields, sends them + page texts + document map to Haiku. Reviewer can: confirm (`verifiziert: true`), correct source (`quelle_korrigiert`), correct value (`aktion: "korrigieren"` — new value must exist verbatim in document), or remove value (`aktion: "entfernen"` — nulls wert). Atomic mutation staging prevents partial state on errors.

### Frontend (React 18 + Vite + Tailwind CSS, port 3005)
- **Pages**: Login → Dashboard (upload + extraction results + PDF viewer) → History
- **Extraction UI**: Tab-based display (`components/extraction/tabs/`) — Overview, Schuldner, Antragsteller, Forderungen, Ermittlung, Anschreiben, Prüfliste, Fehlend
- **PDF Viewer**: `components/pdf/PdfViewer.tsx` — side-by-side view with page navigation + mark.js text highlighting, linked to extraction source references via `DataField` click
- **Auth**: JWT with refresh tokens via `context/AuthContext.tsx` and `hooks/useAuth`
- **Proxy**: Vite proxies `/api` to backend (configurable via `VITE_PROXY_TARGET`)

### Shared Types (`shared/types/extraction.ts`)
- Canonical type definitions for `ExtractionResult`, `SourcedValue<T>`
- Backend duplicates these in `backend/src/types/extraction.ts` to avoid `rootDir` issues with tsc
- **When modifying types**: update both `shared/types/extraction.ts` and `backend/src/types/extraction.ts`

### Standardschreiben (`standardschreiben/`)
- `checklisten.json` — defines required fields per letter type, aliases, default recipients
- `platzhalter-mapping.json` — maps template placeholders to extraction field paths
- PDF templates for the 10 standard letter types

## Key Patterns

- **SourcedValue pattern**: Every extracted data field uses `{wert: T | null, quelle: string, verifiziert?: boolean, pruefstatus?: Pruefstatus}`. The `quelle` must reference the exact page ("Seite X, ..."). This pattern is central to the entire data model.
- **Asymmetric trust in pipeline**: Stage 2 (extractor) is creative — it finds and assigns values. Stage 3 (reviewer) is critical — it can only confirm, correct to values in the document, or remove. The reviewer cannot invent values.
- **Path alias**: Both frontend and backend use `@shared/*` → `../shared/*` (tsconfig paths + vite alias)
- **Env validation**: Backend uses Zod schema in `config.ts` — fails fast on missing/invalid env vars
- **Logging**: Winston logger (`src/utils/logger.ts`), never logs PDF content (BRAO compliance for German law firms)
- **Graceful degradation**: If any pipeline stage fails (document analysis, verification), the pipeline continues with reduced quality rather than failing entirely

## Environment

Requires `.env` at project root with `ANTHROPIC_API_KEY`, `JWT_SECRET` (min 32 chars), `DEFAULT_ADMIN_PASSWORD`. See `.env.example` for all variables.

## Ports

| Service        | Dev   | Docker Prod |
|----------------|-------|-------------|
| Backend        | 3004  | 3004        |
| Frontend       | 3005  | 3002        |
