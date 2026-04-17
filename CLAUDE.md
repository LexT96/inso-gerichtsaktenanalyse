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
npm run benchmark -- ../path/to.pdf    # Run extraction + save to benchmark DB
npm run benchmark:list                 # Show all benchmark runs
npm run benchmark:compare -- 1,2       # Compare two runs field-by-field

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
          Stage 0 (conditional): ocrService.ts (Azure Document Intelligence)
          If scanned PDF detected (avg <50 chars/page): OCR via Azure DI prebuilt-layout
          Caches results by PDF hash (data/ocr-cache/) incl. word polygons + tables
          Chunks large PDFs to ≤4MB. Adds invisible OCR text layer to PDF (ocrLayerService.ts)
          for frontend text selection/highlighting on scanned docs.
          Watermark removal applied to OCR output
                        ↓ pageTexts + ocrResult (tables, confidence, word positions)
          Stage 1: documentAnalyzer.ts (Sonnet on Langdock, cached system prompt)
          Maps document structure + classifies pages by domain (forderungen/aktiva/anfechtung)
                        ↓ documentMap + ExtractionRouting + ocrHints (confidence warnings)
          Stage 2a: anthropic.ts (Sonnet + Extended Thinking)
          Base extraction: scalar fields only. Hybrid image+text mode on Langdock
          (20 key page images + full OCR text). Native PDF mode on direct Anthropic.
                        ↓ base ExtractionResult
          Stage 2b: Parallel focused passes (overwrite base result sections)
          ├── forderungenExtractor.ts (Sonnet) — enriched text + table structures + page images
          ├── aktivaExtractor.ts (Sonnet on Langdock) — enriched text + page images
          └── anfechtungsAnalyzer.ts (Sonnet on Langdock) — enriched text + page images
          Token budget guard: all pages if <450K chars, routed subset if over, hard truncate if still over.
          All prompts use cached system prompts (cache_control: ephemeral, 90% input savings).
          Rate limiter: global semaphore limits concurrent heavy calls (MAX = TPM / 80K).
                        ↓ merged ExtractionResult
          Stage 3: semanticVerifier.ts (Sonnet on Langdock, cached prompt)
          Verifies scalar fields only. SKIPS array elements from focused passes
          (einzelforderungen, positionen, vorgaenge — prevents mass-removal).
                        ↓
          Stage 3b: Targeted re-extraction (scalar fields only, source pages only)
                        ↓
          Stage 3c: Handwriting extraction (native PDF or text-mode fallback)
          Detects Fragebogen pages → sends as mini-PDF or OCR text → merges form fields
                        ↓
          Stage 4: Post-processing (deterministic, NO LLM arithmetic)
          Gender inference, boolean defaults, arbeitnehmer fallback, TEUR parsing
                        ↓
          Stage 5: Validation-driven retry (if critical fields missing)
          Checks Aktenzeichen, Gericht, Name/Firma, Datum. Retries with targeted prompt.
                        ↓ verified ExtractionResult
          letterChecklist.ts — validates 10 standard letter types
```

- **Stage 0 — OCR** (`src/services/ocrService.ts`): Azure DI `prebuilt-layout`. Returns text + tables (129 on Eilers) + per-word confidence + bounding polygons. `ocrLayerService.ts` overlays invisible searchable text on scanned PDFs using word polygons. Cache includes all data for text layer regeneration.
- **Stage 1 — Document Analysis** (`src/utils/documentAnalyzer.ts`): Sonnet call (Haiku not available on Langdock) → text map + segments. `classifySegmentsForExtraction()` routes pages by keywords. Cached system prompt.
- **Stage 2a — Base Extraction** (`src/services/anthropic.ts`): Sonnet + Extended Thinking. On Langdock: hybrid image+text mode (20 key page images + full OCR text). On direct Anthropic: native PDF mode. Prompt caching on system prompt.
- **Stage 2b — Focused Passes** (parallel): All use Sonnet on Langdock. `ocrEnricher.ts` provides enriched page content (text + structured tables + confidence warnings from Azure DI). `pageImageRenderer.ts` renders page images via pymupdf for visual context. Token budget guard: send all pages if <450K chars, keyword-routed subset if over, hard truncate to fit.
- **Stage 3 — Semantic Verification** (`src/utils/semanticVerifier.ts`): Verifies scalar fields ONLY. `SKIP_VERIFICATION_PREFIXES` excludes `einzelforderungen[*]`, `positionen[*]`, `vorgaenge[*]` — focused pass outputs are trusted, not re-verified by the cheaper verifier.
- **Stage 3c — Handwriting** (`src/services/extraction.ts`): Works in both native PDF mode (mini-PDF) and text mode (Langdock). 13 Fragebogen pages detected on Eilers PDF.
- **Stage 5 — Validation Retry**: Checks 4 critical fields after post-processing. If missing, retries with two-step reasoning on first 30 pages.
- **API Layer** (`src/services/anthropic.ts`): `createAnthropicMessage()` handles prompt caching, streaming (Langdock), rate limiting, and timeouts. Smart streaming: <50K tokens → non-streaming (faster), >50K → streaming with retry on stall.
- **Rate Limiter** (`src/services/rateLimiter.ts`): Global token-aware semaphore. `MAX_CONCURRENT_HEAVY = floor(TPM / 80K)`. Tracks active extractions.

### Gutachten Generation (`src/utils/gutachtenGenerator.ts`)
- **Templates**: 3 DOCX templates in `gutachtenvorlagen/` (natürliche Person, juristische Person, Personengesellschaft). Rebuilt from 3 real finalized TBS Gutachten — all `[...]` replaced with `[[SLOT_NNN: descriptive context]]` markers, standard legal boilerplate filled in (VID §4, §17/§19 definitions, Zuständigkeit). Change markers `⚡KI:` for review.
- **KI_* Replacement**: 90+ placeholders mapped via `gutachten-mapping.json`. XML text replacement with paragraph-flattening (`processDocxParagraphs`) to handle Word run-splitting. Computed fields include gender variants, InsVV fee calculation, gesellschafter formatting.
- **Dynamic Tables**: `buildAktivaTable` (5-column: Wert/Absonderung/Aussonderung/Freie Masse), `buildPassivaTable` (Gläubiger/Betrag), `buildGlaeubigerTable` (detailed), `buildAnfechtungTable`.
- **InsVV Calculation**: `berechneVerfahrenskosten()` — § 2 Abs. 1 (7 brackets), § 11 (25% vorläufig), GKG KV Nr. 2310. Available as computed fields `KI_Verfahrenskosten_Berechnung`, `KI_Verfahrenskosten_Gesamt`, `KI_Freie_Masse_Gesamt`.
- **Slot Filling** (`src/utils/gutachtenSlotFiller.ts`): Extracts `[[SLOT_NNN]]` markers, fills via Claude API with few-shot examples from real TBS Gutachten. Factual slots → Haiku, narrative slots → Sonnet. Batches of 40, 16384 max_tokens.
- **Two endpoints**: `POST /:id/prepare` (JSON with slots) → `POST /:id/generate` (DOCX download)
- **Template rebuild script**: `scripts/rebuild-templates.py` — Python script using python-docx to update templates from real Gutachten examples.

### Frontend (React 18 + Vite + Tailwind CSS, port 3005)
- **Design**: Geist Mono + DM Sans fonts, maroon accent (#A52A2A), shadows + rounded corners
- **Pages**: Login (TBS branded) → Dashboard (upload + results + PDF viewer) → History
- **10 Tabs**: Übersicht, Quellen, Beteiligte, Forderungen, Aktiva, Anfechtung, Ermittlung, Prüfliste, Anschreiben, Gutachten
- **Tab Navigation**: Priority+ overflow with group separators, sticky position
- **PDF Viewer**: Side-by-side with paragraph-level semantic highlighting, single-click jump
- **Entity-aware display**: GmbH shows firma/rechtsform/HRB + Gesellschafter table + steuerliche Angaben + sonstige Angaben; natürliche Person shows name/geburtsdatum/familienstand + telefon/email + steuerliche & sonstige Angaben (collapsed sections)
- **Calculations** (frontend-only, verified): InsVV § 2 Abs. 1 (7 brackets), GKG KV Nr. 2310 (1.5 Gebühren), Quotenberechnung with § 171 Kostenbeiträge
- **Cross-Validation**: Sum consistency, familienstand↔ehegatte, betriebsstätte↔privatanschrift, anfechtungspotenzial ratio
- **Demo flow** (`frontend/public/demo/`): `loadDemo()` fetches `test-pdf.pdf` + `mock-result.json` and renders them in the split view. The result is also persisted via `POST /api/extract/demo` (result-only, no PDF file stored under `/data/pdfs/`) so Gutachten generation has an `extractionId`. Button gated by `import.meta.env.DEV || VITE_ENABLE_DEMO_FLOW === '1'`. `mock-result.json` MUST conform to the current `ExtractionResult` schema — a type mismatch (e.g. string instead of `SourcedValue[]`) crashes the whole tab tree and makes the PDF panel disappear.
- **Demo history deep-link**: Because `/api/extract/demo` does not store the source PDF, `loadFromHistory` falls back to fetching `/demo/test-pdf.pdf` when `data.filename === 'demo-test.pdf'` and `/api/history/:id/pdf` returns 404. Without this fallback, `/dashboard?id=N` for a demo extraction shows the results but no PDF viewer on the left.

### Shared Types (`shared/types/extraction.ts`)
- Canonical type definitions for `ExtractionResult`, `SourcedValue<T>`, `Einzelforderung`, `Aktivum` (+ liquidationswert/fortfuehrungswert/absonderung/aussonderung/freie_masse), `AnfechtbarerVorgang`, `Insolvenzanalyse`, `Ehegatte`, `Beschaeftigung`, `Pfaendungsberechnung`, `Gesellschafter`
- `Schuldner` has 50+ fields: personal data, corporate data (satzungssitz, gesellschafter[], geschaeftsfuehrer, prokurist, stammkapital, groessenklasse_hgb), tax data (finanzamt, steuernummer, ust_id, wirtschaftsjahr), misc (telefon, email, steuerberater, bankverbindungen, insolvenzsonderkonto)
- `Verfahrensdaten` includes `internationaler_bezug` and `eigenverwaltung` (SourcedBoolean)
- Backend duplicates these in `backend/src/types/extraction.ts` to avoid `rootDir` issues with tsc
- **When modifying types**: update both `shared/types/extraction.ts` and `backend/src/types/extraction.ts`

### Gutachtenvorlagen (`gutachtenvorlagen/`)
- 3 DOCX templates with `KI_*` placeholders (90+ unique, all mapped in `gutachten-mapping.json`) and `[[SLOT_NNN: context]]` markers for AI filling
- Templates rebuilt from 3 real finalized TBS Gutachten (Geldt natürliche Person, freiraum 3 GmbH, Carl Puricelli Stiftung). Standard legal boilerplate (VID, §17/§19 InsO definitions, Zuständigkeit) pre-filled. Zero remaining `[...]` brackets.
- Template selection by `schuldner.rechtsform` (longest-match-first)
- `gutachten-mapping.json` — field mappings: `path` (ExtractionResult lookup), `computed` (gender/address derivation, InsVV fees, gesellschafter formatting), `input` (user-provided)

### Standardschreiben (`standardschreiben/`)
- `checklisten.json` — defines required fields per letter type, aliases, default recipients
- DOCX templates for the 10 standard letter types

## Key Patterns

- **SourcedValue pattern**: Every extracted data field uses `{wert: T | null, quelle: string, verifiziert?: boolean, pruefstatus?: Pruefstatus}`. The `quelle` must reference the exact page ("Seite X, ..."). This pattern is central to the entire data model.
- **Asymmetric trust in pipeline**: Stage 2 (extractor) is creative — it finds and assigns values. Stage 3 (reviewer) is critical — it can only confirm, correct to values in the document, or remove. The reviewer cannot invent values.
- **Entity-aware processing**: `isJuristischePerson()` detected via rechtsform regex. Affects: displayed fields, Prüfliste scope, computeStats counting, BeteiligteTab sections.
- **Watermark removal**: `removeWatermarks()` in pdfProcessor has 3 strategies: (1) whole-line watermarks on >80% of pages, (2) suffix watermarks (name+date appended to last line), (3) short-fragment watermarks from OCR debris — only activates when 5+ co-occurring fragments detected (prevents false positives on repeated names).
- **OCR caching**: `ocrService.ts` caches Azure DI results (text + tables + word polygons + confidence) by SHA-256 PDF hash in `data/ocr-cache/`. Same PDF skips OCR. Cache includes polygon data for text layer regeneration.
- **OCR text layer**: `ocrLayerService.ts` overlays invisible searchable text on scanned PDFs using Azure DI word-level bounding polygons via pymupdf. Enables text selection/highlighting in frontend PDF viewer.
- **OCR enrichment for focused passes**: `ocrEnricher.ts` builds enriched page content with structured table data + confidence warnings from Azure DI. Only for focused passes (10-30 pages), NOT base extraction (avoids prompt bloat).
- **Prompt caching**: All API calls use `createAnthropicMessage()` with optional `cachedSystemPrompt` parameter. Static prompts cached via `cache_control: ephemeral` (5 min TTL, 90% input savings).
- **Smart streaming**: `createAnthropicMessage()` uses non-streaming for small calls (<50K tokens, faster) and streaming for large calls (avoids Langdock Cloudflare 524 timeout). Streaming calls have 5 min timeout + 1 retry on stall.
- **Rate limiter**: `rateLimiter.ts` — global token-aware semaphore. Heavy calls (>50K tokens) limited to `floor(TPM / 80K)` concurrent. Tracks active extractions for monitoring.
- **Boolean schema safety**: `sourcedBooleanSchema` maps "nicht bekannt"/"unbekannt" → `null` (unknown), never to `false`. Only explicit confirmations → `true`.
- **Merge deduplication**: `einzelforderungen` merge by composite key (glaeubiger + betrag + titel). `aktiva.positionen` merge by beschreibung.
- **Path alias**: Both frontend and backend use `@shared/*` → `../shared/*` (tsconfig paths + vite alias)
- **Logging**: Winston logger, never logs PDF content (BRAO compliance)
- **Graceful degradation**: Every pipeline stage has try/catch, continues with reduced quality on failure

## Environment

Requires `.env` at project root with `ANTHROPIC_API_KEY`, `JWT_SECRET` (min 32 chars), `DEFAULT_ADMIN_PASSWORD`, `DB_ENCRYPTION_KEY` (min 32 chars). Optional: `EXTRACTION_MODEL` (default: `claude-sonnet-4-6`), `UTILITY_MODEL` (default: `claude-haiku-4-5-20251001`), `ANTHROPIC_BASE_URL` (for Langdock EU proxy: `https://api.langdock.com/anthropic/eu`), `AZURE_DOC_INTEL_ENDPOINT` + `AZURE_DOC_INTEL_KEY` (enables OCR for scanned PDFs). See `.env.example` for all variables.

**Production (Langdock EU)**: `ANTHROPIC_BASE_URL=https://api.langdock.com/anthropic/eu`, `EXTRACTION_MODEL=claude-sonnet-4-6-default`, `UTILITY_MODEL=claude-sonnet-4-6-default`. All data stays in EU. 200K TPM per model.

**Benchmark CLI**: `npm run benchmark -- path/to/pdf`, `npm run benchmark:list`, `npm run benchmark:compare -- 1,2`. Results in `data/benchmarks.db`.

## Ports

| Service        | Dev   | Docker Prod |
|----------------|-------|-------------|
| Backend        | 3004  | 3004        |
| Frontend       | 3005  | 3002        |
