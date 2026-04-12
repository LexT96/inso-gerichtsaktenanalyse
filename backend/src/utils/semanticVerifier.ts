/**
 * Semantic page reference verification using Claude Haiku.
 *
 * Replaces the text-matching pageVerifier with API calls that
 * understand document context and authoritative sources.
 *
 * For large documents: only sends referenced pages (not all pages)
 * and splits into batches to stay within rate limits.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { callWithRetry, extractJsonFromText, createAnthropicMessage } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import { parallelLimitSettled } from './parallel';
import type { ExtractionResult } from '../types/extraction';

// ─── Types ───

interface SourcedField {
  wert: unknown;
  quelle: string;
  verifiziert?: boolean;
}

interface CollectedField {
  ref: SourcedField;
  path: string;
}

interface VerificationEntry {
  nr: number;
  verifiziert: boolean;
  quelle_korrigiert?: string;
  begruendung?: string;
  aktion?: 'entfernen' | 'korrigieren';
  korrekter_wert?: unknown;
  korrekte_quelle?: string;
}

// ─── Field collection ───

function isSourcedField(obj: unknown): obj is SourcedField {
  if (obj === null || obj === undefined || typeof obj !== 'object') return false;
  return 'wert' in obj && 'quelle' in obj;
}

function wertIsEmpty(wert: unknown): boolean {
  if (wert === null || wert === undefined) return true;
  if (typeof wert === 'string') return wert.trim() === '';
  return false;
}

/**
 * Walk an ExtractionResult and collect all {wert, quelle} fields
 * that have non-empty wert values, along with their dot-notation paths.
 */
// Fields that should NOT be sent to the semantic verifier:
// - Computed values that don't exist verbatim in documents
// - Synthesized text fields (summaries of multiple values, not verbatim quotes)
const SKIP_VERIFICATION_PATHS = new Set([
  'schuldner.pfaendungsberechnung.pfaendbarer_betrag',
  // Computed/inferred fields — not verbatim in documents, verifier rejects unfairly
  'schuldner.arbeitnehmer_anzahl',       // Often inferred from context, not stated as number
  'schuldner.betriebsrat',               // Boolean derived from checkbox
  'schuldner.steuerliche_organschaft',    // Boolean derived from checkbox
  'forderungen.gesicherte_forderungen',   // Computed sum, not stated verbatim
  'forderungen.ungesicherte_forderungen', // Computed sum
  'aktiva.summe_aktiva',                  // Computed sum of positions
  'aktiva.massekosten_schaetzung',        // Estimated, not in document
  'anfechtung.gesamtpotenzial',           // Estimated sum
  'verfahrensdaten.eroeffnungsgrund',     // Legal classification, often paraphrased
  'verfahrensdaten.internationaler_bezug', // Boolean inference
  'verfahrensdaten.eigenverwaltung',      // Boolean inference
]);

// Suffix patterns: fields ending with these within arrays are skipped
// (the titel of a forderung is a summary like "SV 5.104 + SZ 387 + MG 57",
//  not a verbatim quote — verifier would incorrectly remove it)
const SKIP_VERIFICATION_SUFFIXES = [
  '.titel',          // Forderungstitel = synthesized from sub-amounts
];

// Prefix patterns for array elements from focused passes.
// These come from dedicated Stage 2b extractors (Sonnet/Haiku) that read
// only the relevant pages — Haiku re-verification actively harms quality.
// Evidence: Sonnet forderungen pass found 77 creditors, Haiku verifier
// mass-removed 56 glaeubiger names it couldn't find in its page batch.
const SKIP_VERIFICATION_PREFIXES = [
  'forderungen.einzelforderungen[',  // from forderungenExtractor (Sonnet)
  'aktiva.positionen[',              // from aktivaExtractor (Haiku)
  'anfechtung.vorgaenge[',           // from anfechtungsAnalyzer (Haiku)
];

export function collectFields(obj: unknown, prefix: string = ''): CollectedField[] {
  const fields: CollectedField[] = [];

  if (obj === null || obj === undefined || typeof obj !== 'object') return fields;

  if (isSourcedField(obj)) {
    const shouldSkip = SKIP_VERIFICATION_PATHS.has(prefix)
      || SKIP_VERIFICATION_SUFFIXES.some(suffix => prefix.endsWith(suffix))
      || SKIP_VERIFICATION_PREFIXES.some(pfx => prefix.startsWith(pfx));
    if (!wertIsEmpty(obj.wert) && !shouldSkip) {
      fields.push({ ref: obj, path: prefix });
    }
    return fields;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      fields.push(...collectFields(obj[i], `${prefix}[${i}]`));
    }
    return fields;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    fields.push(...collectFields(value, path));
  }

  return fields;
}

// ─── Prompt ───

const VERIFICATION_PROMPT = `Du bist ein kritischer Prüfer für extrahierte Daten aus einer deutschen Insolvenzakte.
Du prüfst UND korrigierst fehlerhafte Extraktionen.

Für jedes Feld prüfe:
1. Kommt der Wert tatsächlich im Dokument vor?
2. Ist die angegebene Seite korrekt?
3. Ist die Quelle die AUTORITATIVE Fundstelle — nicht bloß irgendeine Erwähnung?
4. Passt der Wert INHALTLICH zum Feld, oder wurde er dem falschen Feld zugeordnet?

Autoritative Quellen in Insolvenzakten:
- Verfahrensdaten (Aktenzeichen, Gericht, Richter, Beschlussdatum, Antragsart) → Beschluss/Verfügung des Gerichts
- Schuldnerdaten (Name, Adresse, Geburtsdatum, Firma) → Rubrum des Beschlusses oder Insolvenzantrag
- Antragstellerdaten (Name, Adresse, Forderungen) → Insolvenzantrag
- Forderungen (Beträge, Zeiträume) → Insolvenzantrag / Forderungsaufstellung
- Gutachterbestellung → Beschluss zur Gutachterbestellung
- Ermittlungsergebnisse Grundbuch → Grundbuchauskunft/-mitteilung
- Ermittlungsergebnisse Gerichtsvollzieher → Mitteilung des Gerichtsvollziehers
- Ermittlungsergebnisse Meldeauskunft → Meldebehördliche Auskunft
- Ermittlungsergebnisse Vollstreckungsportal → Schuldnerverzeichnis-Auskunft

WICHTIG: Ein Datum, Name oder Betrag kann auf mehreren Seiten vorkommen. Wähle die Seite, auf der der Wert in seinem FACHLICHEN KONTEXT steht — nicht die erste oder zufällige Erwähnung.

ALLGEMEINE PRÜFREGELN — prüfe diese für JEDES Feld:
1. UNBEKANNT: Wenn das Dokument eine Information ausdrücklich als unbekannt beschreibt ("ist mir nicht bekannt", "konnte nicht ermittelt werden", "keine Angabe möglich", "nicht bekannt"), der Wert aber trotzdem gesetzt wurde → aktion: "entfernen"
2. FALSCHER KONTEXT: Wenn ein Wert aus dem falschen Dokumentteil stammt (z.B. ein Datum aus einem Beschluss statt aus dem Zustellungsvermerk, eine Adresse aus dem falschen Abschnitt) und der korrekte Wert im Dokument steht → aktion: "korrigieren"
3. FALSCHE ZUORDNUNG: Wenn ein Wert identisch mit einem anderen Feld ist, wo er nicht hingehört (z.B. Privatanschrift als Betriebsstätte eingetragen) → aktion: "entfernen"
4. FALSCHES DATUM/WERT: Wenn ein anderer Wert aus dem Dokument das fachlich korrekte Ergebnis wäre (z.B. handschriftliches Zustelldatum statt gedrucktes Beschlussdatum) → aktion: "korrigieren"

SICHERHEITSREGEL: Bei aktion "korrigieren" MUSS der korrekter_wert WÖRTLICH im Dokumenttext vorkommen. Du darfst KEINE neuen Werte erfinden, berechnen oder zusammensetzen. Nur Werte verwenden, die im Text stehen.

BOOLEAN-FELDER (grundbesitz_vorhanden, betriebsstaette_bekannt, masse_deckend, etc.):
- Wenn das Dokument klar verneint ("kein Grundbesitz", "keine Daten gefunden", "nicht vorhanden") → der Wert sollte false sein, NICHT null
- Wenn ein solches Boolean-Feld fälschlich auf null steht, aber das Dokument eine klare Verneinung enthält → aktion: "korrigieren", korrekter_wert: false

ERGEBNISSE:
- Wert korrekt + Quelle korrekt → verifiziert: true
- Wert korrekt, falsche Seite → verifiziert: true + quelle_korrigiert
- Wert FALSCH, korrekter Wert im Dokument → verifiziert: false + aktion: "korrigieren" + korrekter_wert + korrekte_quelle + begruendung
- Wert FALSCH, sollte entfernt werden → verifiziert: false + aktion: "entfernen" + begruendung

Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Markdown, keine Erklärung):
[{"nr": 1, "verifiziert": true}, {"nr": 2, "verifiziert": true, "quelle_korrigiert": "Seite X, Beschluss"}, {"nr": 3, "verifiziert": false, "aktion": "entfernen", "begruendung": "Dokument sagt: nicht bekannt"}, {"nr": 4, "verifiziert": false, "aktion": "korrigieren", "korrekter_wert": "28.11.2025", "korrekte_quelle": "Seite 5, Zustellungsvermerk", "begruendung": "Handschriftliches Zustelldatum statt Beschlussdatum"}]`;

// ─── Token estimation ───

// Budget per API call — stays under the 50k tokens/min rate limit with headroom
const TOKEN_BUDGET = 40_000;
const CHARS_PER_TOKEN = 2.5; // German text with umlauts needs lower estimate (A3)
// Pages around each referenced page to include for context
const PAGE_BUFFER = 2;
// Max fields per verification batch to prevent output truncation (A2)
const MAX_FIELDS_PER_BATCH = 25;
// Max tokens for verification response
const VERIFICATION_MAX_TOKENS = 12_288;
// Concurrency limit for parallel verification batches
const VERIFICATION_CONCURRENCY = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Page selection ───

/**
 * Parse all page numbers from a quelle string.
 * Handles: "Seite 5", "Seiten 5-7", "Seiten 3 und 5", "Seiten 3, 5 und 7", "Seiten 3-5 und 8"
 */
export function parsePagesFromQuelle(quelle: string): number[] {
  // Match "Seite(n) <number-sequence>" pattern
  const match = quelle.match(/Seiten?\s+([\d\s,\-–und]+)/i);
  if (!match) return [];

  const pages = new Set<number>();
  // Split on commas and "und", then handle ranges
  const parts = match[1].replace(/und/g, ',').split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i++) pages.add(i);
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) pages.add(num);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Collect page numbers referenced by fields + buffer pages around each.
 * Returns sorted unique page numbers (1-based).
 */
function collectRelevantPages(fields: CollectedField[], totalPages: number): number[] {
  const pages = new Set<number>();
  for (const f of fields) {
    const parsed = parsePagesFromQuelle(f.ref.quelle);
    for (const page of parsed) {
      for (let i = Math.max(1, page - PAGE_BUFFER); i <= Math.min(totalPages, page + PAGE_BUFFER); i++) {
        pages.add(i);
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Build page text block from specific page numbers only.
 */
function buildSelectedPageBlock(pageTexts: string[], pageNumbers: number[]): string {
  return pageNumbers
    .map(p => `=== SEITE ${p} ===\n${pageTexts[p - 1]}`)
    .join('\n\n');
}

function buildFieldList(fields: CollectedField[], globalOffset: number = 0): string {
  return fields
    .map((f, i) => {
      const wert = typeof f.ref.wert === 'string' ? f.ref.wert : String(f.ref.wert);
      return `${globalOffset + i + 1}. ${f.path} | Wert: "${wert}" | Quelle: "${f.ref.quelle}"`;
    })
    .join('\n');
}

// ─── Parse verification response ───

function parseVerificationResponse(text: string): VerificationEntry[] {
  const jsonStr = extractJsonFromText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(jsonStr));
      logger.info('Verifikations-JSON per jsonrepair repariert');
    } catch (err) {
      logger.error('Verifikations-JSON konnte nicht geparst werden', {
        error: err instanceof Error ? err.message : String(err),
        sample: jsonStr.slice(0, 300),
      });
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    logger.error('Verifikations-Antwort ist kein Array');
    return [];
  }

  return parsed.filter(
    (e): e is VerificationEntry =>
      e != null &&
      typeof e === 'object' &&
      typeof (e as VerificationEntry).nr === 'number' &&
      typeof (e as VerificationEntry).verifiziert === 'boolean'
  );
}

// ─── Batch helpers ───

interface BatchDef {
  fields: CollectedField[];
  globalOffset: number;
  pageBlock: string;
  pageCount: number;
}

/**
 * Split fields into batches that each fit within the token budget.
 * Each batch only includes pages referenced by its fields.
 */
function splitIntoBatches(fields: CollectedField[], pageTexts: string[]): BatchDef[] {
  // Try all fields in one batch first (if within both token and field count limits)
  const allPages = collectRelevantPages(fields, pageTexts.length);
  const allBlock = buildSelectedPageBlock(pageTexts, allPages);

  if (estimateTokens(allBlock) <= TOKEN_BUDGET && fields.length <= MAX_FIELDS_PER_BATCH) {
    return [{ fields, globalOffset: 0, pageBlock: allBlock, pageCount: allPages.length }];
  }

  // Split by both token budget and max field count
  const estimatedBatches = Math.max(
    Math.ceil(fields.length / MAX_FIELDS_PER_BATCH),
    Math.ceil(estimateTokens(allBlock) / TOKEN_BUDGET) + 1
  );
  const batchSize = Math.min(MAX_FIELDS_PER_BATCH, Math.ceil(fields.length / estimatedBatches));
  const batches: BatchDef[] = [];

  for (let i = 0; i < fields.length; i += batchSize) {
    const slice = fields.slice(i, i + batchSize);
    const pages = collectRelevantPages(slice, pageTexts.length);
    const pageBlock = buildSelectedPageBlock(pageTexts, pages);
    batches.push({ fields: slice, globalOffset: i, pageBlock, pageCount: pages.length });
  }

  return batches;
}

// ─── Apply entries ───

interface Mutation {
  ref: SourcedField;
  verifiziert: boolean;
  quelle?: string;
  setWert?: { value: unknown };
}

interface VerifyStats {
  verified: number;
  sourceCorrected: number;
  valueCorrected: number;
  removed: number;
  failed: number;
}

function processEntries(
  entries: VerificationEntry[],
  fields: CollectedField[],
  mutations: Mutation[],
  stats: VerifyStats
): void {
  for (const entry of entries) {
    const localIdx = entry.nr - 1;
    if (localIdx < 0 || localIdx >= fields.length) continue;

    const ref = fields[localIdx].ref;

    if (entry.verifiziert) {
      if (entry.quelle_korrigiert) {
        mutations.push({ ref, verifiziert: true, quelle: entry.quelle_korrigiert });
        stats.sourceCorrected++;
      } else {
        mutations.push({ ref, verifiziert: true });
        stats.verified++;
      }
    } else if (entry.aktion === 'korrigieren' && entry.korrekter_wert !== undefined) {
      mutations.push({
        ref,
        verifiziert: true,
        setWert: { value: entry.korrekter_wert },
        quelle: entry.korrekte_quelle,
      });
      stats.valueCorrected++;
    } else if (entry.aktion === 'entfernen') {
      mutations.push({
        ref,
        verifiziert: false,
        setWert: { value: null },
      });
      stats.removed++;
    } else {
      mutations.push({ ref, verifiziert: false });
      stats.failed++;
    }
  }
}

// ─── Main ───

/**
 * Semantically verify and correct all extracted fields in an ExtractionResult.
 *
 * Smart page selection: only sends pages referenced by extracted fields
 * (plus a small buffer), not the entire document. For large documents,
 * automatically splits into multiple API calls to stay within rate limits.
 *
 * On API failure: logs warning, returns result unchanged (graceful degradation).
 */
export interface VerifyResult {
  result: ExtractionResult;
  removedPaths: string[];
}

export async function semanticVerify(
  result: ExtractionResult,
  pageTexts: string[],
  documentMap?: string
): Promise<VerifyResult> {
  const allFields = collectFields(result);

  if (allFields.length === 0) {
    logger.info('Keine Felder zur Verifikation gefunden');
    return { result, removedPaths: [] };
  }

  const batches = splitIntoBatches(allFields, pageTexts);
  const mapBlock = documentMap ? `\n--- STRUKTURÜBERSICHT ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n` : '';

  logger.info('Verifikation gestartet', {
    totalFields: allFields.length,
    totalPages: pageTexts.length,
    batches: batches.length,
    pagesPerBatch: batches.map(b => b.pageCount),
  });

  // Build verification tasks for each batch
  const batchTasks = batches.map((batch, batchIdx) => async () => {
    const batchMutations: Mutation[] = [];
    const batchStats: VerifyStats = { verified: 0, sourceCorrected: 0, valueCorrected: 0, removed: 0, failed: 0 };
    let inputTokens = 0;
    let outputTokens = 0;

    const fieldList = buildFieldList(batch.fields);

    const content = `${VERIFICATION_PROMPT}
${mapBlock}
--- AKTENINHALT (${batch.pageCount} relevante Seiten von ${pageTexts.length} gesamt) ---

${batch.pageBlock}

--- EXTRAHIERTE FELDER (${batch.fields.length} Stück) ---

${fieldList}`;

    const response = await callWithRetry(() =>
      createAnthropicMessage({
        model: config.UTILITY_MODEL,
        max_tokens: VERIFICATION_MAX_TOKENS,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    const entries = parseVerificationResponse(text);

    inputTokens += response.usage?.input_tokens ?? 0;
    outputTokens += response.usage?.output_tokens ?? 0;

    // Truncation retry: if response was cut off, retry remaining fields
    if (response.stop_reason === 'max_tokens' && entries.length < batch.fields.length) {
      logger.warn('Verifikations-Antwort abgeschnitten — Retry für verbleibende Felder', {
        batch: batchIdx + 1,
        entriesReceived: entries.length,
        fieldsInBatch: batch.fields.length,
      });

      processEntries(entries, batch.fields, batchMutations, batchStats);

      const answeredNrs = new Set(entries.map(e => e.nr));
      const remainingFields = batch.fields.filter((_, i) => !answeredNrs.has(i + 1));

      if (remainingFields.length > 0) {
        const retryFieldList = buildFieldList(remainingFields);
        const retryContent = `${VERIFICATION_PROMPT}
${mapBlock}
--- AKTENINHALT (${batch.pageCount} relevante Seiten von ${pageTexts.length} gesamt) ---

${batch.pageBlock}

--- EXTRAHIERTE FELDER (${remainingFields.length} Stück, Retry) ---

${retryFieldList}`;

        const retryResponse = await callWithRetry(() =>
          createAnthropicMessage({
            model: config.UTILITY_MODEL,
            max_tokens: VERIFICATION_MAX_TOKENS,
            messages: [{ role: 'user' as const, content: retryContent }],
          })
        ) as Anthropic.Message;

        const retryText = retryResponse.content
          .filter((c): c is Anthropic.TextBlock => c.type === 'text')
          .map((c: Anthropic.TextBlock) => c.text)
          .join('');

        const retryEntries = parseVerificationResponse(retryText);

        processEntries(retryEntries, remainingFields, batchMutations, batchStats);

        inputTokens += retryResponse.usage?.input_tokens ?? 0;
        outputTokens += retryResponse.usage?.output_tokens ?? 0;

        logger.info(`Verifikation Retry für Batch ${batchIdx + 1} abgeschlossen`, {
          retryFields: remainingFields.length,
          retryEntries: retryEntries.length,
        });
      }
    } else {
      processEntries(entries, batch.fields, batchMutations, batchStats);
    }

    logger.info(`Verifikation Batch ${batchIdx + 1}/${batches.length} abgeschlossen`, {
      fieldsInBatch: batch.fields.length,
      pagesInBatch: batch.pageCount,
      inputTokens,
    });

    return { mutations: batchMutations, stats: batchStats, inputTokens, outputTokens };
  });

  // Run batches in parallel — Langdock now has 200K TPM, no longer rate-limited
  const isRateLimited = false;

  let batchResults: (Awaited<ReturnType<typeof batchTasks[0]>> | undefined)[];
  let batchErrors: (Error | undefined)[];

  if (isRateLimited) {
    logger.info('Rate-limited provider: Verifikation seriell mit 62s Pause');
    batchResults = [];
    batchErrors = [];
    for (let i = 0; i < batchTasks.length; i++) {
      if (i > 0) {
        logger.info(`Rate-limit Pause vor Batch ${i + 1}/${batchTasks.length} (62s)`);
        await new Promise(r => setTimeout(r, 62_000));
      }
      try {
        batchResults.push(await batchTasks[i]());
        batchErrors.push(undefined);
      } catch (err) {
        batchResults.push({ mutations: [], stats: { verified: 0, sourceCorrected: 0, valueCorrected: 0, removed: 0, failed: 0 }, inputTokens: 0, outputTokens: 0 });
        batchErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } else {
    const settled = await parallelLimitSettled(batchTasks, VERIFICATION_CONCURRENCY);
    batchResults = settled.results as typeof batchResults;
    batchErrors = settled.errors as typeof batchErrors;
  }

  // Aggregate results from all batches
  const mutations: Mutation[] = [];
  const stats: VerifyStats = { verified: 0, sourceCorrected: 0, valueCorrected: 0, removed: 0, failed: 0 };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < batchResults.length; i++) {
    if (batchErrors[i]) {
      logger.warn(`Verifikation Batch ${i + 1}/${batches.length} fehlgeschlagen — übersprungen`, {
        error: batchErrors[i]!.message,
        fieldsInBatch: batches[i].fields.length,
      });
      continue;
    }
    const br = batchResults[i]!;
    mutations.push(...br.mutations);
    stats.verified += br.stats.verified;
    stats.sourceCorrected += br.stats.sourceCorrected;
    stats.valueCorrected += br.stats.valueCorrected;
    stats.removed += br.stats.removed;
    stats.failed += br.stats.failed;
    totalInputTokens += br.inputTokens;
    totalOutputTokens += br.outputTokens;
  }

  // Track which fields were removed (for targeted re-extraction)
  const removedPaths: string[] = [];

  // Apply all mutations atomically
  for (const m of mutations) {
    m.ref.verifiziert = m.verifiziert;
    if (m.quelle !== undefined) {
      m.ref.quelle = m.quelle;
    }
    if (m.setWert !== undefined) {
      m.ref.wert = m.setWert.value;
      // Track removed fields for potential re-extraction
      if (m.setWert.value === null) {
        const field = allFields.find(f => f.ref === m.ref);
        if (field) removedPaths.push(field.path);
      }
    }
  }

  const skipped = allFields.length - mutations.length;

  logger.info('Semantische Verifikation abgeschlossen', {
    total: allFields.length,
    ...stats,
    skipped,
    removedPaths: removedPaths.length > 0 ? removedPaths : undefined,
    batches: batches.length,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  });

  return { result, removedPaths };
}
