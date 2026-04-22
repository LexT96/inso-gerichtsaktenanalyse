# Image-batched Handwriting Extraction für Langdock

## Problem

Stage 3c (Handwriting-Pass) in `backend/src/services/extraction.ts` re-extrahiert handgeschriebene Werte aus Fragebogen-Seiten (Telefon, E-Mail, Steuerberater, Geschäftszweig usw.). Heute zwei Modi:

- **native-pdf** — sendet Mini-PDF als `type: 'document'`. Beste Qualität. Funktioniert nur direkt gegen Anthropic / Vertex.
- **text** (fallback) — sendet Azure DI OCR-Text der Form-Seiten. Azure DI ist auf deutscher Handschrift mittelmäßig (~50-70% Char-Accuracy auf Schreibschrift / Kästchen-Ziffern).

Production läuft auf der Langdock EU-Proxy (Datenresidenz). Langdock blockiert `type: 'document'`. Resultat: Prod fällt in Text-Modus → liefert in der letzten Cochem-Akte `mode:"text", fieldsFound:55, merged:0`. Pass ist effektiv tot in Production.

Langdock unterstützt **`type: 'image'`** (base64 JPEG/PNG) — verifiziert in `backend/src/services/anthropic.ts:961-980`, wo die Stage-2a Hybrid-Extraktion bereits 20 Seiten-Bilder via Langdock an Claude schickt.

## Ziel

Dritter Modus **image-batched** für die Langdock-Konstellation: Fragebogen-Seiten als JPEG-Bilder rendern, gebatched an Claude Vision via Langdock schicken, gleicher HANDWRITING_PROMPT, gleiche Merge-Logik.

Sekundäres Ziel: Erkannte handschriftliche Werte werden im OCR-Layer der PDF suchbar, sodass Frontend Ctrl-F sie findet (page-scoped, nicht pixelgenau).

## Architektur

### Provider-Verzweigung in `extractHandwriting()`

```
formPages = detectFragebogenPages(pageTexts)
if (!pdfBuffer)                       -> text-mode (status quo fallback)
else if (anthropicSupportsNativePdf()) -> native-pdf (status quo, unchanged)
else                                   -> NEU: image-batched
```

`anthropicSupportsNativePdf()` existiert seit PR #17 (`backend/src/services/extractionProvider.ts`).

### Image-batched Pfad — Schritte

1. **Render** alle `formPages` einmalig als JPEG via existierendem `renderPagesToJpeg(pdfBuffer, pages, dpi=150)` aus `backend/src/utils/pageImageRenderer.ts` (Helper hat bereits einen `dpi`-Parameter, default 100; übergeben wir 150). Returns `Map<pageIdx, base64-jpeg>`. Render-Fehler einzelner Seiten kommen als fehlende Map-Einträge zurück → loggen + Batch entfernt sie, restliche Pipeline läuft weiter.
2. **Batch** zu Gruppen von **4 Seiten** (`chunk(formPages, 4)`).
3. **Concurrency-Gate 2**: maximal 2 Batches gleichzeitig in-flight. Inline-Implementierung via einfachem Index-basierten Worker-Pattern (kein p-limit-Dep — `package.json` hat es nicht; vermeidet neue Dep). Alle Batches via `Promise.allSettled` einsammeln (nicht `Promise.all` — partielle Fails dürfen nicht alle Geschwister mitreißen).
4. **Pro Batch** ein Claude-Vision-Call via `createAnthropicMessage`:
   - Content-Blocks: `[text("=== SEITE 4 ==="), image(p4), text("=== SEITE 5 ==="), image(p5), ..., text(HANDWRITING_PROMPT + page-mapping-suffix)]`
   - **Page-Label vor jedem Image** — Claude muss eindeutig wissen welches Bild welche Original-Seite ist, sonst halluziniert es die `quelle`-Angabe
   - `cache_control: { type: 'ephemeral' }` auf den letzten Text-Block (Prompt) → 90% input-cache-hit auf Folge-Batches innerhalb 5min TTL
   - `max_tokens: 8192` (wie heute)
   - Nach Response: `stop_reason === 'end_turn'` prüfen; bei `'max_tokens'` warn-log + jsonrepair-Pass auf evtl. abgeschnittenes JSON
5. **Merge** alle erfolgreichen Batch-Outputs via existierendem `mergeField`/Skipped-Logging (PR #17). Bei `Promise.allSettled`-Rejected einen warn-log mit Batch-Indizes, weiterlaufen.

### Token-Math (verifiziert via Codex-Review)

- A4 @ 150 DPI ≈ 1240×1754 px = 2.18 MP. Anthropic image-token estimate: `width*height/750` vor model-resize → ~2.9K Tokens/Seite.
- 4 Seiten/Batch ≈ 12K Image-Tokens + ~1K Text. Liegt deutlich unter Anthropic's per-message-limit und unter Langdock's 200K TPM-Burst.
- Cochem-Akte: 22 Form-Seiten = 6 Batches × ~13K = ~78K Total-Input. Mit Concurrency 2 = ~3 Wellen á ~26K = ~30s Latenz.
- Cost-Schätzung: ~0.30-0.50 EUR pro Cochem-Akte (Sonnet 4.6 input rate), ~0.10 EUR median.

**Bekannte Engstelle**: der globale `rateLimiter.ts` schätzt Tokens nur aus Text-Blocks via `estimateTokens` und sieht Image-Tokens nicht. Bei dieser Feature relevant: Image-Tokens sind klein genug dass kein Hard-Limit gerissen wird, aber wir loggen bewusst die geschätzten Image-Tokens für künftige Tuning-Sichtbarkeit.

### OCR-Layer-Anbindung (sekundäres Ziel)

Zweck: Frontend Ctrl-F im PDF-Viewer findet handschriftliche Werte auf der Originalseite.

Vorgehen:
- Pro erfolgreich extrahiertem Feld einen synthetischen Eintrag in `ocrResult.pages[pageIdx].wordConfidences` einfügen:
  - `text` = der erkannte Wert
  - `polygon` = Dummy-Rechteck im **Footer-Bereich** der Seite (z.B. `[0, page_height-30, page_width, page_height-30, page_width, page_height, 0, page_height]` in inches)
  - `confidence` = niedrig (z.B. 0.5) als Marker dass es synthetisch ist
- `addOcrTextLayer` (`backend/src/services/ocrLayerService.ts`) ist agnostisch zur Quelle — keine Änderung dort nötig
- Frontend findet beim Suchen den Wert auf der richtigen Seite, Highlight zeigt im Footer-Bereich (Seite stimmt, Position approximativ)

Codex-Empfehlung "keine fake-Positionen erfinden" wird damit so umgesetzt: explizit als Footer-Annotation, nicht als angeblicher Position der Original-Handschrift.

## Schnittstellen

Keine neuen externen API-Endpoints. Innere Funktionen:

```ts
// in extractionProvider.ts (existiert bereits seit PR #17)
export function anthropicSupportsNativePdf(): boolean

// in extraction.ts (intern, nicht exportiert)
async function extractHandwritingImageBatched(
  pdfBuffer: Buffer,
  formPages: number[],
  result: ExtractionResult,
  pageMapping: string,
): Promise<{ parsed: Record<string, ...>, batchesOk: number, batchesFailed: number }>

// existierend in pageImageRenderer.ts — direkt nutzbar, kein neuer Helper nötig
export function renderPagesToJpeg(
  pdfBuffer: Buffer, pageIndices: number[], dpi?: number
): Map<number, string>  // base64
```

Logger-Output erweitert um `mode:"image-batched"`, `batches`, `batchesOk`, `batchesFailed`, `imageTokensEstimated`.

## Failure-Modes & Handling

| Mode | Handling |
|---|---|
| Render einzelner Seite scheitert | Skip + warn-log, restliche Batches laufen weiter |
| Batch-Call wirft Network/429/500 | `Promise.allSettled` fängt → warn-log, andere Batches behalten |
| Batch-Response truncated (`stop_reason: max_tokens`) | warn-log, jsonrepair-pass; gerettete Felder mergen |
| JSON-Parse scheitert komplett | warn-log, Batch verworfen; siehe existing handler in extraction.ts:548 |
| Alle Batches fail | warn-log "Handwriting image-batched lieferte keine Daten", result unverändert zurück (kein throw) |
| `pdfBuffer` null | text-mode fallback wie heute |

## Tests (TDD)

Aktuell keine Tests für `extractHandwriting` (live LLM-Call). Neu:

- **Unit**: `chunk(pages, size)` boundaries (verschachtelt mit Edge-Cases: leeres Array, weniger Seiten als Batch-Size).
- **Unit**: `pageImageRenderer.renderPagesAsImages` mit DPI-Param — Output-Größe ungefähr im erwarteten Bereich.
- **Integration / Mock**: `extractHandwritingImageBatched` mit gemocktem `createAnthropicMessage` (returned 2 von 3 erfolgreichen JSON-Batches → merge sieht Felder beider, loggt 1 failed).

## Out of Scope

- Override-Mode (Handschrift überschreibt Base-Werte) — behalten "fill-only-empty" Verhalten von PR #17, Auswertung der `skipped`-Logs entscheidet später ob Override sinnvoll.
- Nicht-Schuldner-Felder aus Handschrift (Mietrückstände, Lohnrückstände, Grundstück-Details) — kein Schema-Ziel, prompt-Erweiterung wäre eigenes Feature.
- Pixel-genaue Highlight-Positionen für handschriftliche Werte — explizit Footer-Annotation, kein Aufwand für synthetische Polygon-Berechnung.

## Migration / Rollback

- Reines Code-Add, keine Schema-Migration, keine DB-Änderung
- Bei Problemen: rollback per `git revert` — `extractHandwriting` fällt zurück auf Native-PDF (lokal) bzw. Text-Mode (prod = Status quo, leeres Result)
- Keine breaking change am Public API
