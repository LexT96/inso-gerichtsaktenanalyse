# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TBS Aktenanalyse — AI-powered insolvency case analysis tool for German law firm Prof. Dr. Dr. Thomas B. Schmidt. Uploads court file PDFs, extracts structured data via Claude API (Sonnet with Extended Thinking), verifies page references semantically, generates Gutachten (expert reports) from DOCX templates, and checks readiness of 10 standard letter types. All UI and logs are in German. BRAO-compliant.

## Development Commands

```bash
# Backend (from /backend)
npm run dev          # Start with tsx watch (hot-reload), port 3004
npm run build        # TypeScript compile to dist/
npm run test         # vitest run (one-shot)
npm run test:watch   # vitest (watch mode)
npm run verify -- ../path/to/akte.pdf  # Extract + verify PDF (full pipeline)
npm run verify -- --id=1               # Verify existing extraction from DB

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
- **Config**: `src/config.ts` — Zod-validated env vars (`EXTRACTION_MODEL` defaults to `claude-sonnet-4-6`, `UTILITY_MODEL` to Haiku)
- **Database**: SQLite via `better-sqlite3`, WAL mode, encrypted at rest
- **Routes**: `src/routes/` — auth (JWT), extraction (PDF upload + SSE), history, generateLetter, generateGutachten (prepare + generate endpoints), fieldUpdate

### Extraction Pipeline (`src/services/extraction.ts`)

```
PDF → pdfProcessor (watermark removal) → pageTexts
                        ↓
          Stage 1: documentAnalyzer.ts (Haiku)
          Maps document structure: which pages = which document type
                        ↓ documentMap
          Stage 2: anthropic.ts (Sonnet + Extended Thinking)
          Single comprehensive call: extracts ALL fields + aktiva + anfechtung
          Uses system prompt (prompt injection defense) + prompt caching
          PDFs ≤500 pages: native PDF mode
          PDFs >500 pages: chunked fallback with separate aktiva/anfechtung
                        ↓ ExtractionResult
          Stage 3: semanticVerifier.ts (Haiku)
          Verifies + corrects fields against actual page texts
          Skips computed fields (pfaendbarer_betrag) and synthesized fields (.titel)
                        ↓
          Stage 3b: Targeted re-extraction (Haiku)
          Re-extracts only fields removed by Stage 3 (recovers 5-15%)
                        ↓ verified ExtractionResult
          letterChecklist.ts — validates 10 standard letter types
```

- **Stage 1 — Document Analysis** (`src/utils/documentAnalyzer.ts`): Haiku call → text map of document structure. Graceful degradation on failure.
- **Stage 2 — Comprehensive Extraction** (`src/services/anthropic.ts`): Single Sonnet call with Extended Thinking (10K token budget). Streaming API for long operations. System prompt separated from user content. Prompt caching via `cache_control: ephemeral`. Extracts: verfahrensdaten, schuldner (+ ehegatte, beschaeftigung, pfaendungsberechnung), antragsteller, einzelforderungen (dynamic array with sicherheiten), aktiva (10 categories + insolvenzanalyse), anfechtung (§§ 129-147 InsO), ermittlungsergebnisse, standardanschreiben.
- **Stage 3 — Semantic Verification** (`src/utils/semanticVerifier.ts`): Collects all `{wert, quelle}` fields (except `SKIP_VERIFICATION_PATHS` and `.titel` suffix fields), verifies against page texts. Can: confirm, correct source, correct value, or remove. Returns `removedPaths` for targeted re-extraction.
- **Aktiva Extractor** (`src/utils/aktivaExtractor.ts`): Fallback for chunked mode. 10 asset categories, InsVV-based cost estimation, insolvency analysis (§§ 17-19, 26 InsO).
- **Anfechtung Analyzer** (`src/utils/anfechtungsAnalyzer.ts`): Fallback for chunked mode. Identifies contestable transactions with lookback periods and risk assessment.

### Gutachten Generation (`src/utils/gutachtenGenerator.ts`)
- **Templates**: 3 DOCX templates in `gutachtenvorlagen/` (natürliche Person, juristische Person, Personengesellschaft)
- **FELD_* Replacement**: 28 placeholders mapped via `gutachten-mapping.json`. XML text replacement with paragraph-flattening (`processDocxParagraphs`) to handle Word run-splitting.
- **Slot Filling** (`src/utils/gutachtenSlotFiller.ts`): Extracts ~100 `[…]` placeholders as numbered `[[SLOT_NNN]]` markers, fills via Claude API, returns for user review.
- **Two endpoints**: `POST /:id/prepare` (JSON with slots) → `POST /:id/generate` (DOCX download)

### Frontend (React 18 + Vite + Tailwind CSS, port 3005)
- **Design**: Geist Mono + DM Sans fonts, maroon accent (#A52A2A), shadows + rounded corners
- **Pages**: Login (TBS branded) → Dashboard (upload + results + PDF viewer) → History
- **10 Tabs**: Übersicht, Quellen, Beteiligte, Forderungen, Aktiva, Anfechtung, Ermittlung, Prüfliste, Anschreiben, Gutachten
- **Tab Navigation**: Priority+ overflow with group separators, sticky position
- **PDF Viewer**: Side-by-side with paragraph-level semantic highlighting, single-click jump
- **Entity-aware display**: GmbH shows firma/rechtsform/HRB; natürliche Person shows name/geburtsdatum/familienstand
- **Calculations** (frontend-only, verified): InsVV § 2 Abs. 1 (7 brackets), GKG KV Nr. 2310 (1.5 Gebühren), Quotenberechnung with § 171 Kostenbeiträge
- **Cross-Validation**: Sum consistency, familienstand↔ehegatte, betriebsstätte↔privatanschrift, anfechtungspotenzial ratio

### Shared Types (`shared/types/extraction.ts`)
- Canonical type definitions for `ExtractionResult`, `SourcedValue<T>`, `Einzelforderung`, `Aktivum`, `AnfechtbarerVorgang`, `Insolvenzanalyse`, `Ehegatte`, `Beschaeftigung`, `Pfaendungsberechnung`
- Backend duplicates these in `backend/src/types/extraction.ts` to avoid `rootDir` issues with tsc
- **When modifying types**: update both `shared/types/extraction.ts` and `backend/src/types/extraction.ts`

### Gutachtenvorlagen (`gutachtenvorlagen/`)
- 3 DOCX templates with `FELD_*` placeholders (28 unique, all mapped in `gutachten-mapping.json`)
- Template selection by `schuldner.rechtsform` (longest-match-first)
- `gutachten-mapping.json` — field mappings: `path` (ExtractionResult lookup), `computed` (gender/address derivation), `input` (user-provided)

### Standardschreiben (`standardschreiben/`)
- `checklisten.json` — defines required fields per letter type, aliases, default recipients
- DOCX templates for the 10 standard letter types

## Key Patterns

- **SourcedValue pattern**: Every extracted data field uses `{wert: T | null, quelle: string, verifiziert?: boolean, pruefstatus?: Pruefstatus}`. The `quelle` must reference the exact page ("Seite X, ..."). This pattern is central to the entire data model.
- **Asymmetric trust in pipeline**: Stage 2 (extractor) is creative — it finds and assigns values. Stage 3 (reviewer) is critical — it can only confirm, correct to values in the document, or remove. The reviewer cannot invent values.
- **Entity-aware processing**: `isJuristischePerson()` detected via rechtsform regex. Affects: displayed fields, Prüfliste scope, computeStats counting, BeteiligteTab sections.
- **Watermark removal**: `removeWatermarks()` in pdfProcessor detects text appearing on >80% of pages (whole-line and suffix patterns) and strips it before extraction.
- **Boolean schema safety**: `sourcedBooleanSchema` maps "nicht bekannt"/"unbekannt" → `null` (unknown), never to `false`. Only explicit confirmations → `true`.
- **Merge deduplication**: `einzelforderungen` merge by composite key (glaeubiger + betrag + titel). `aktiva.positionen` merge by beschreibung.
- **Path alias**: Both frontend and backend use `@shared/*` → `../shared/*` (tsconfig paths + vite alias)
- **Logging**: Winston logger, never logs PDF content (BRAO compliance)
- **Graceful degradation**: Every pipeline stage has try/catch, continues with reduced quality on failure

## Environment

Requires `.env` at project root with `ANTHROPIC_API_KEY`, `JWT_SECRET` (min 32 chars), `DEFAULT_ADMIN_PASSWORD`, `DB_ENCRYPTION_KEY` (min 32 chars). Optional: `EXTRACTION_MODEL` (default: `claude-sonnet-4-6`), `UTILITY_MODEL` (default: `claude-haiku-4-5-20251001`). See `.env.example` for all variables.

## Ports

| Service        | Dev   | Docker Prod |
|----------------|-------|-------------|
| Backend        | 3004  | 3004        |
| Frontend       | 3005  | 3002        |
