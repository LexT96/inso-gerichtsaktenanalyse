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

### Kanzlei Settings (`src/routes/kanzlei.ts`)
- `kanzlei.json` in `gutachtenvorlagen/` — firm data (partners, standorte, insolvenzgerichte), used by computed KI_* fields
- `GET/PUT /api/kanzlei` — read/write kanzlei.json. `invalidateKanzleiCache()` after write.
- Template upload: `PUT /api/kanzlei/templates/:type` — validates required KI_* placeholders via PizZip text extraction (joins `<w:t>` to handle Word run-splitting). Creates `.backup.docx` before overwrite.
- Sidebar (partner listing) is static in templates — edited by TBS in Word, not programmatically

### DOCX Generation Gotchas
- **Word run-splitting**: Word splits placeholder text across `<w:r>` elements (e.g., `KI_` + `Gericht_Ort`). Always join all `<w:t>` content before searching for placeholders.
- **mc:AlternateContent**: Text boxes have TWO copies in DOCX XML — `wps:txbxContent` (modern) inside `mc:Choice` AND `w:txbxContent` inside `v:textbox` (VML fallback). Must update both or they desync.
- **Tracked changes vs tabs**: `replaceFieldsInXml` uses tracked changes for simple paragraphs but in-place replacement for paragraphs with `<w:tab/>` (preserves tabs + per-run bold formatting).
- **verwalter_titel line breaks**: Comma-separated titles split into `\n`, rendered as `<w:br/>` in DOCX via `trackInsert`.

### Forderungen: Gesicherte vs Ungesicherte (InsO §§47-51)
- Computed deterministically in post-processing from `einzelforderungen[].sicherheit.absonderungsberechtigt`
- Absonderung (true): Grundschuld §49, Sicherungsübereignung §51 Nr.1, Pfandrecht §50, Globalzession §51 Nr.1
- No Absonderung (false): Bürgschaft (personal, no estate lien), einfacher Eigentumsvorbehalt (§47 = Aussonderung)
- Partial security: `min(betrag, geschaetzter_wert)` caps the gesicherte portion
- `getNum`/`safeWert` in frontend: check for comma before applying German format parsing (prevents "566765.38" → 56M bug)

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
- `checklisten.json` — defines required fields per letter type, aliases, default recipients, and `templateDocx` pointing to the DOCX vorlage. Strafakte also has `uiInputs` declaring per-generation freitext-fields (person, tatvorwurf, gegenstand).
- `templates/*.docx` — 10 DOCX vorlagen with `FELD_*` placeholders (no curly braces, analog zu `KI_*` bei Gutachten). Generated from the original muster-PDFs via `scripts/convert-letter-pdfs.py` (Claude Vision pipeline).
- `platzhalter-mapping.json` — maps every `FELD_*` to a source: `path` (ExtractionResult lookup), `computed` (gender variants, verfahren_art, antwort_frist, etc.), `verwalter` (verwalter_profiles column), `static` (constant), `input` (per-generation user input).

### Letter Generation (`src/routes/generateLetter.ts` + `src/utils/letterGenerator.ts`)
- `POST /api/generate-letter/:extractionId/:typ` — body: `{ verwalterId?: number, extras?: Record<string,string> }`. Returns DOCX or 4xx.
- `letterGenerator.generateLetterFromTemplate(buffer, result, verwalter, extras)` — loads mapping, walks `<w:p>` paragraphs via inlined `processDocxParagraphs` (run-splitting safe), longest-first token replacement, final FELD_* wipe.
- Gender helpers (`src/utils/genderHelpers.ts`) handle schuldner/verwalter forms including Nominativ (der/die), Akkusativ (den/die), Dativ (dem/der), Genitiv (Schuldners/Schuldnerin), and the Halters/Halterin phrase. Masculine default; explicit `'maennlich'`/`'männlich'` + feminine recognized.
- `extras.verwalter_art` overrides the `Insolvenzverwalter` default (because `verwalter_profiles` has no `art` column).
- Missing `verwalter_id` → 422 with `code: 'VERWALTER_REQUIRED'` (frontend surfaces tip to use Gutachten-Assistent).
- Strafakte-Akteneinsicht requires `extras.strafverfahren_{person,tatvorwurf,gegenstand}` — enforced via `uiInputs` checklist; 422 with `missing: [...]` if empty.

### Letter Templates Admin (`src/routes/letterTemplates.ts`)
- `GET /api/letter-templates` — list all 10 templates with size, lastModified, hasBackup.
- `GET /:typ/download` — stream current DOCX.
- `PUT /:typ` — multipart upload (field: `template`, 10 MB max). Validates uploaded DOCX contains every `FELD_*` present in the current template; 422 with `missing` array otherwise. Creates `.backup.docx` before overwrite.
- `POST /:typ/rollback` — restore from `.backup.docx` and delete the backup.
- AdminPage "BRIEFE" tab (`LetterTemplatesSection`) drives all four actions.

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

Requires `.env` at project root with `ANTHROPIC_API_KEY`, `JWT_SECRET` (min 32 chars), `DEFAULT_ADMIN_PASSWORD`, `DB_ENCRYPTION_KEY` (min 32 chars). Optional: `EXTRACTION_MODEL` (default: `claude-sonnet-4-6`), `UTILITY_MODEL` (default: `claude-haiku-4-5-20251001`), `ANTHROPIC_BASE_URL` (for Langdock EU proxy: `https://api.langdock.com/anthropic/eu`), `AZURE_DOC_INTEL_ENDPOINT` + `AZURE_DOC_INTEL_KEY` (enables OCR for scanned PDFs), `VITE_APP_TITLE` (browser tab title, default `Aktenanalyse`; demo-Server setzt `Demo Aktenanalyse`). See `.env.example` for all variables.

**Production (Langdock EU)**: `ANTHROPIC_BASE_URL=https://api.langdock.com/anthropic/eu`, `EXTRACTION_MODEL=claude-sonnet-4-6-default`, `UTILITY_MODEL=claude-sonnet-4-6-default`. All data stays in EU. 200K TPM per model.

## Deployment & Branching

Details in `docs/pipeline.md`.

**Branches:**

| Branch | Default? | Auto-Deploy | Container-Prefix |
|--------|----------|-------------|------------------|
| `dev`  | yes      | —           | — (nur CI)       |
| `main` | —        | prod → `aktenanalyse.klareprozesse.de` | `tbs-aktenanalyse-*` |
| `demo` | —        | demo → `https://46-224-7-60.sslip.io`  | `app-*`              |

Feature-Branches zweigen von `dev` ab, PR → `dev`. Prod-Release: PR `dev → main` (squash). Demo-Update: GH Actions "Promote main → demo" (merge, behält demo-only `kanzlei.json` + `gutachtenvorlagen/`).

`main` und `demo` sind protected — required CI (`backend` + `frontend`), kein Force-Push.

**Server-Layout (identisch für prod + demo):**

- Git-Clone auf Server (prod: `/opt/tbs-aktenanalyse`, demo: `/opt/app`), tracked den jeweiligen Branch
- `.env` auf Server liegt außerhalb von git (Secrets + demo setzt `VITE_APP_TITLE=Demo Aktenanalyse`)
- SQLite in Docker Named Volume (`{tbs-aktenanalyse,app}_db-data`) überlebt Redeploys
- Caddy (Reverse Proxy + Let's Encrypt prod / self-signed demo) → frontend (nginx) + backend (Node)

**Workflows** in `.github/workflows/`:

- `ci.yml` — PRs + pushes nach dev/demo/main: Backend `tsc + vitest`, Frontend `tsc -b + vite build`. Backend-Tests nutzen dummy env vars (config.ts validiert min. 32 Zeichen für JWT/DB-Keys).
- `deploy-demo.yml` / `deploy-prod.yml` — auf push in den jeweiligen Branch: SSH zu VM, `git reset --hard origin/<branch>` + `docker compose up -d --build`. Pfad via `{DEMO,PROD}_DEPLOY_PATH` Secret konfigurierbar, Default `/opt/app`. Prod zusätzlich geguarded durch Repo-Variable `PROD_ENABLED=true`.
- `promote-main-to-demo.yml` — manuell (workflow_dispatch): merged `main` in `demo` (oder rebase), erhält demo-only Commits. Bei Konflikten (z.B. `gutachtenvorlagen/`) → manuell lokal lösen.

**GH Secrets** (pro Environment): `<ENV>_SSH_KEY`, `<ENV>_HOST`, `<ENV>_USER`, optional `<ENV>_DEPLOY_PATH`. Deploy-Keys sind ed25519, pubkey in `/root/.ssh/authorized_keys` mit Comment `github-actions-deploy-<env>@klareprozesse`.

## Benchmarks

`data/benchmarks.db` (SQLite) speichert Extraktion-Runs für Modellvergleiche. Schema in `backend/src/services/benchmarkService.ts`.

```bash
npm run benchmark -- path/to/akte.pdf                           # Run + save
npm run benchmark -- path/to/akte.pdf --notes="sonnet 4.6 EU"   # mit Notiz
npm run benchmark:list                                          # alle Runs
npm run benchmark:list -- --doc=<sha256>                        # pro PDF
npm run benchmark:compare -- 1,2                                # Diff Feld-für-Feld
```

Document-Dedup via SHA-256 PDF-Hash → gleiche PDF, verschiedene Runs bleiben gruppiert. Provider-Info (`EXTRACTION_PROVIDER`, `EXTRACTION_MODEL`, Langdock vs direct Anthropic) wird per Run gespeichert.

**Prompt-Tuning** (optional): `promptfooconfig.yaml` im Repo-Root, Test-DB `data/insolvenz-promptfoo-test.db`.

## Stack-Überblick

**Backend** (Node 20, TypeScript, Express 4):
- HTTP: `express`, `cors`, `cookie-parser`, `helmet`, `express-rate-limit`, Multer für PDF-Uploads
- DB: `better-sqlite3` (SQLite + WAL), verschlüsselt via HKDF-abgeleitetem Schlüssel aus `DB_ENCRYPTION_KEY`
- Auth: `jsonwebtoken` + `bcrypt` (lokal), `jwks-rsa` (optional Azure AD SSO)
- LLM: `@anthropic-ai/sdk` (+ `@anthropic-ai/vertex-sdk` für GCP), `openai` (Provider-Switch via `EXTRACTION_PROVIDER=openai`, z.B. GPT-5.4)
- PDF-Text: `pdf-parse` (schnelle Text-Extraktion), `pdf-lib` (Manipulation z.B. mini-PDFs für Stage 2b/3c)
- PDF-Rendering + OCR-Layer: `pymupdf` via Python-Subprocess (Seiten → JPEG für Vision-Calls, invisible Text-Overlay auf gescannten PDFs via word-polygons)
- OCR: Azure Document Intelligence `prebuilt-layout`, angesprochen via raw `fetch` (kein SDK), Response-Cache per SHA-256 PDF-Hash in `data/ocr-cache/`
- DOCX: `docxtemplater` + `pizzip` (XML-Replacement mit zwei Pässen: per-`<w:t>` zuerst, dann flatten-fallback)
- Utility: `zod` (Schema-Validierung, inkl. `sourcedBooleanSchema`), `zod-to-json-schema`, `jsonrepair` (für truncated Claude-Output), `uuid`, `winston` + `winston-daily-rotate-file` (BRAO-konform, loggt nie PDF-Inhalt)
- Test: `vitest` (109 Tests), Helper: `tsx` (watch-dev + CLI-Skripte)

**Frontend** (React 18, TypeScript, Vite 6):
- Routing: `react-router-dom` 7, API: `axios`
- Styling: Tailwind CSS 3 (mit `postcss` + `autoprefixer`), Geist Mono + DM Sans
- PDF-Viewer: `react-pdf` (pdf.js) mit paragraph-level Highlighting, `mark.js` für Text-Suche
- SSO: `@azure/msal-browser` + `@azure/msal-react` (optional, aktiv wenn `VITE_AZURE_TENANT_ID` gesetzt)

**Infra / Dev:**
- Docker + docker-compose: `docker-compose.yml` (prod mit Caddy/TLS), `docker-compose.prod-ip.yml` (prod ohne Domain), `docker-compose.dev.yml` (hot-reload)
- Caddy 2 (Reverse Proxy + auto Let's Encrypt bei gesetztem `DOMAIN_NAME`)
- Terraform (`hcloud` provider) für Hetzner-Provisionierung, `terraform/` im Repo
- GitHub Actions CI/CD (siehe Deployment & Branching)

**Python-Helfer:**
- `pymupdf` (Runtime: Rendering + OCR-Text-Layer-Overlay)
- `python-docx` (Scripts: Template-Rebuild aus realen Gutachten, `scripts/rebuild-templates.py`)
- Scripts auch: `scripts/convert-letter-pdfs.py` (Muster-PDFs → DOCX via Claude Vision), `scripts/update-briefkopf.py` (Kanzlei-Daten-Sync)

## Ports

| Service        | Dev   | Docker Prod |
|----------------|-------|-------------|
| Backend        | 3004  | 3004        |
| Frontend       | 3005  | 3002        |
