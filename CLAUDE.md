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
          Maps document structure + classifies pages by domain (forderungen/aktiva/anfechtung)
                        ↓ documentMap + ExtractionRouting
          Stage 2a: anthropic.ts (Sonnet + Extended Thinking)
          Base extraction: scalar fields only (verfahrensdaten, schuldner, antragsteller, etc.)
          Trimmed prompt — no detailed forderungen/aktiva/anfechtung instructions
                        ↓ base ExtractionResult
          Stage 2b: Parallel focused passes (overwrite base result sections)
          ├── forderungenExtractor.ts (Sonnet) — all einzelforderungen from creditor pages
          ├── aktivaExtractor.ts (Haiku) — all aktiva positions from asset pages
          └── anfechtungsAnalyzer.ts (Haiku) — anfechtung from transaction pages
                        ↓ merged ExtractionResult
          Stage 3: semanticVerifier.ts (Haiku)
          Verifies + corrects fields against actual page texts
                        ↓
          Stage 3b: Targeted re-extraction (Haiku)
          Re-extracts only fields removed by Stage 3 (recovers 5-15%)
                        ↓
          Stage 3c: Focused handwriting extraction (native PDF only)
          Detects Fragebogen pages → extracts as mini-PDF → focused OCR prompt
                        ↓
          Stage 4: Post-processing (deterministic, NO LLM arithmetic)
          Gender inference, boolean defaults, arbeitnehmer fallback
          ALWAYS recomputes: summe_aktiva, gesamtforderungen, gesamtpotenzial, freie_masse
          Parses TEUR amounts from titel ("X TEUR" and "TEUR X" → X * 1000)
          Computes betrag from Nennbetrag+Zinsen in titel
          Rejects page references as glaeubiger names
                        ↓ verified ExtractionResult
          letterChecklist.ts — validates 10 standard letter types
```

- **Stage 1 — Document Analysis** (`src/utils/documentAnalyzer.ts`): Haiku call → text map of document structure. `classifySegmentsForExtraction()` routes pages by keyword matching to forderungen/aktiva/anfechtung domains. Graceful degradation on failure.
- **Stage 2a — Base Extraction** (`src/services/anthropic.ts`): Sonnet call with Extended Thinking. Trimmed prompt extracts only scalar fields. Forderungen/aktiva/anfechtung sections are stubs ("detaillierte Extraktion erfolgt in separatem Schritt").
- **Stage 2b — Focused Passes** (parallel): `forderungenExtractor.ts` (Sonnet, not Haiku — Haiku drops names from long tables), `aktivaExtractor.ts` (Haiku), `anfechtungsAnalyzer.ts` (Haiku). Each gets only domain-relevant pages via `ExtractionRouting`. Results REPLACE the corresponding section from base extraction. Rate-limited providers serialize with 62s delays.
- **Stage 3c — Handwriting Extraction** (`src/services/extraction.ts`): Detects Fragebogen/Anlage pages by text markers, extracts them as mini-PDF via `pdf-lib`, sends to Claude with focused OCR prompt. Merges handwritten fields (telefon, email, betriebsstaette, etc.) into main result. Only runs in native PDF mode (direct Anthropic API).
- **Stage 4 — Post-processing** (`src/services/extraction.ts`): ALL arithmetic is deterministic code, never LLM. `summe_aktiva` from positions, `gesamtforderungen` from einzelforderungen, `gesamtpotenzial` from vorgaenge, `freie_masse` per position (wert - absonderung - aussonderung). `computeBetragFromTitel()` parses Nennbetrag+Zinsen and TEUR patterns. `looksLikeInvalidGlaeubiger()` rejects numbers, dates, and page references as creditor names. `mergeExtractionResults()` resets derived totals to null before post-processing.
- **Stage 3 — Semantic Verification** (`src/utils/semanticVerifier.ts`): Collects all `{wert, quelle}` fields (except `SKIP_VERIFICATION_PATHS` and `.titel` suffix fields), verifies against page texts. Can: confirm, correct source, correct value, or remove. Returns `removedPaths` for targeted re-extraction.

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
