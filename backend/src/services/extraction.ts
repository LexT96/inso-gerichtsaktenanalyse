import path from 'path';
import { extractComprehensive, extractFromPageTexts, anthropic, callWithRetry, extractJsonFromText } from './anthropic';
import { config } from '../config';
import { extractTextPerPage } from './pdfProcessor';
import { getDb } from '../db/database';
import { writeResultJson } from '../db/resultJson';
import { logger } from '../utils/logger';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { analyzeDocumentStructure } from '../utils/documentAnalyzer';
import type { DocumentAnalysis } from '../utils/documentAnalyzer';
import { semanticVerify } from '../utils/semanticVerifier';
import { extractAktiva } from '../utils/aktivaExtractor';
import { analyzeAnfechtung } from '../utils/anfechtungsAnalyzer';
import { enrichmentReview } from '../utils/enrichmentReview';
import type { ExtractionResult } from '../types/extraction';

// Rate-limited providers (Langdock: 60K TPM) must always use chunked mode
const isRateLimitedProvider = (): boolean =>
  Boolean(config.ANTHROPIC_BASE_URL?.includes('langdock'));

const LARGE_PDF_THRESHOLD = 500; // pages — above this, use chunked fallback
// For rate-limited providers, force chunked mode for any PDF
const effectiveThreshold = (): number => isRateLimitedProvider() ? 0 : LARGE_PDF_THRESHOLD;

interface ExtractionStats {
  found: number;
  missing: number;
  lettersReady: number;
}

function isEmpty(field: { wert?: unknown; quelle?: unknown } | null | undefined): boolean {
  if (!field) return true;
  const w = field.wert;
  return w === null || w === undefined || w === '';
}

// ─── Post-processing: apply transparent defaults and inferences ───

// Common German male/female first names for gender inference
const MALE_NAMES = new Set(['alexander','andreas','bernd','christian','daniel','david','dirk','erik','frank','hans','heinrich','jan','jens','jörg','karl','klaus','lars','lukas','markus','martin','matthias','max','michael','nicolas','oliver','patrick','paul','peter','philipp','ralf','robert','stefan','sven','thomas','tobias','uwe','werner','wolfgang']);
const FEMALE_NAMES = new Set(['alexandra','andrea','angelika','anna','annette','barbara','birgit','brigitte','carmen','charlotte','claudia','daniela','elke','eva','franziska','gabriele','heike','ines','julia','karen','kathrin','katja','kerstin','klara','laura','lisa','maria','marion','martina','monika','nadine','nicole','petra','sabine','sandra','sarah','silke','simone','stefanie','susanne','tanja','ulrike','ursula','yvonne']);

function postProcessDefaults(result: ExtractionResult): ExtractionResult {
  const DEFAULT_QUELLE = 'Standard-Annahme (nicht in Akte erwähnt)';

  // 1. Boolean defaults: internationaler_bezug / eigenverwaltung → false when not mentioned
  if (!result.verfahrensdaten.internationaler_bezug?.wert && result.verfahrensdaten.internationaler_bezug?.wert !== false) {
    result.verfahrensdaten.internationaler_bezug = { wert: false, quelle: DEFAULT_QUELLE };
  }
  if (!result.verfahrensdaten.eigenverwaltung?.wert && result.verfahrensdaten.eigenverwaltung?.wert !== false) {
    result.verfahrensdaten.eigenverwaltung = { wert: false, quelle: DEFAULT_QUELLE };
  }

  // 2. Gender inference from first name
  const s = result.schuldner;
  if (isEmpty(s.geschlecht) && s.vorname?.wert) {
    const vn = String(s.vorname.wert).toLowerCase().trim().split(/[\s-]/)[0];
    if (MALE_NAMES.has(vn)) {
      s.geschlecht = { wert: 'männlich', quelle: `Abgeleitet aus Vorname "${s.vorname.wert}"` };
    } else if (FEMALE_NAMES.has(vn)) {
      s.geschlecht = { wert: 'weiblich', quelle: `Abgeleitet aus Vorname "${s.vorname.wert}"` };
    }
  }

  // 3. Betriebsstätte fallback: if empty but firma address available in other fields
  if (isEmpty(s.betriebsstaette_adresse) && s.firma?.wert) {
    // Check if aktuelle_adresse differs from betriebsstaette — for nat. Personen,
    // betriebsstaette might be in unternehmensgegenstand or zusammenfassung
    const zf = result.zusammenfassung ?? [];
    for (const z of zf) {
      if (!z.wert) continue;
      // Look for patterns like "Zur Oberen Heide 11" or business address mentions
      const match = z.wert.match(/(?:Betriebsstätte|Betrieb|Firmensitz|Geschäftssitz|Unternehmen)[:\s]+([^,]+,\s*\d{5}\s+\w+)/i);
      if (match) {
        s.betriebsstaette_adresse = { wert: match[1].trim(), quelle: z.quelle || 'Zusammenfassung' };
        break;
      }
    }
  }

  // 4. Betriebsrat default: false when not mentioned (only for entities/Einzelunternehmen with employees)
  if (s.firma?.wert && isEmpty(s.betriebsrat)) {
    s.betriebsrat = { wert: false, quelle: DEFAULT_QUELLE };
  }

  // 5. Arbeitnehmer: try to infer from betroffene_arbeitnehmer if schuldner field is empty
  if (isEmpty(s.arbeitnehmer_anzahl)) {
    const an = result.forderungen?.betroffene_arbeitnehmer;
    if (an?.length) {
      let total = 0;
      for (const a of an) {
        if (a && typeof a === 'object' && 'anzahl' in a) total += (a as { anzahl: number }).anzahl || 0;
      }
      if (total > 0) {
        s.arbeitnehmer_anzahl = { wert: total, quelle: 'Abgeleitet aus betroffene Arbeitnehmer' };
      }
    }
  }

  logger.info('Post-processing defaults applied');
  return result;
}

function computeStats(result: ExtractionResult): ExtractionStats {
  let found = 0;
  let missing = 0;

  const walkObj = (obj: Record<string, unknown>): void => {
    if (!obj) return;
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) continue;
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if ('wert' in v || 'quelle' in v) {
          isEmpty(v as { wert?: unknown; quelle?: unknown }) ? missing++ : found++;
        } else {
          walkObj(v as Record<string, unknown>);
        }
      }
    }
  };

  walkObj(result.verfahrensdaten as unknown as Record<string, unknown>);
  walkObj(result.schuldner as unknown as Record<string, unknown>);
  walkObj(result.antragsteller as unknown as Record<string, unknown>);
  walkObj(result.forderungen as unknown as Record<string, unknown>);
  // Also walk each einzelforderung (walkObj skips arrays by default)
  if (result.forderungen?.einzelforderungen) {
    for (const ef of result.forderungen.einzelforderungen) {
      walkObj(ef as unknown as Record<string, unknown>);
    }
  }
  walkObj(result.gutachterbestellung as unknown as Record<string, unknown>);

  const lettersReady = (result.standardanschreiben || [])
    .filter(l => l.status === 'bereit').length;

  return { found, missing, lettersReady };
}

export type ProgressCallback = (message: string, percent: number) => void;

export async function processExtraction(
  pdfBuffer: Buffer,
  filename: string,
  fileSize: number,
  userId: number,
  onProgress?: ProgressCallback,
  modelOverride?: string
): Promise<{ id: number; result: ExtractionResult; stats: ExtractionStats; processingTimeMs: number }> {
  // Pro mode: temporarily swap EXTRACTION_MODEL for this call only
  const originalModel = config.EXTRACTION_MODEL;
  if (modelOverride) {
    (config as Record<string, unknown>).EXTRACTION_MODEL = modelOverride;
    logger.info('Pro-Modus aktiviert', { model: modelOverride });
  }
  try {
  const report = onProgress ?? (() => {});
  const db = getDb();
  const startTime = Date.now();

  // Create extraction record
  const insertResult = db.prepare(
    'INSERT INTO extractions (user_id, filename, file_size, status) VALUES (?, ?, ?, ?)'
  ).run(userId, filename, fileSize, 'processing');
  const extractionId = Number(insertResult.lastInsertRowid);

  try {
    // Save PDF to disk for later viewing (stored alongside DB in /data volume)
    const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
    const fs = await import('fs');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(path.join(pdfDir, `${extractionId}.pdf`), pdfBuffer);
    logger.info('PDF gespeichert', { extractionId, path: path.join(pdfDir, `${extractionId}.pdf`) });

    report('Seitentext wird extrahiert…', 8);

    // Always extract text per page — needed for analysis and verification
    const pageTexts = await extractTextPerPage(pdfBuffer);
    const pageCount = pageTexts.length;
    logger.info('PDF Seitenanzahl ermittelt', { pageCount });

    report(`${pageCount} Seiten erkannt — Dokumentstruktur wird analysiert… (Stufe 1/3)`, 15);

    // Stage 1: Analyze document structure → text map + parsed segments
    const { mapText: documentMap, segments } = await analyzeDocumentStructure(pageTexts);

    report('Daten werden extrahiert… (Stufe 2/3)', 30);

    // Stage 2: Extract data — single comprehensive call for normal PDFs,
    // chunked fallback with separate aktiva/anfechtung for very large PDFs
    let result: ExtractionResult;

    if (pageCount <= effectiveThreshold()) {
      // Single comprehensive call — extracts base data + aktiva + anfechtung
      report(`Vollständige Analyse (${pageCount} S.)… (Stufe 2/3)`, 35);
      result = await extractComprehensive(pdfBuffer, pageTexts, documentMap);
    } else {
      // Fallback: chunked extraction for very large PDFs
      const chunkInfo = segments.length > 0
        ? `dokumentbasiertes Chunking (${segments.length} Segmente)`
        : 'seitenbasiertes Chunking';
      logger.info(`Großes PDF (${pageCount} S.) — verwende ${chunkInfo}`);
      report(`Großes PDF (${pageCount} S.) — Parallele Extraktion… (Stufe 2/3)`, 35);
      result = await extractFromPageTexts(pageTexts, documentMap, segments);

      // For chunked extraction, run aktiva + anfechtung separately
      // On rate-limited providers, serialize with delay
      report('Zusatzanalysen…', 55);
      let aktivaResult: PromiseSettledResult<Awaited<ReturnType<typeof extractAktiva>>>;
      let anfechtungResult: PromiseSettledResult<Awaited<ReturnType<typeof analyzeAnfechtung>>>;

      if (isRateLimitedProvider()) {
        logger.info('Rate-limited provider: Zusatzanalysen seriell mit Pause');
        report('Aktiva-Analyse… (Rate-Limit-Modus)', 55);
        aktivaResult = await extractAktiva(pageTexts, documentMap, result)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
        await new Promise(r => setTimeout(r, 62_000));
        report('Anfechtungsanalyse…', 60);
        anfechtungResult = await analyzeAnfechtung(pageTexts, documentMap, result)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
      } else {
        [aktivaResult, anfechtungResult] = await Promise.allSettled([
          extractAktiva(pageTexts, documentMap, result),
          analyzeAnfechtung(pageTexts, documentMap, result),
        ]);
      }

      if (aktivaResult.status === 'fulfilled' && aktivaResult.value) {
        result.aktiva = aktivaResult.value;
      } else if (aktivaResult.status === 'rejected') {
        logger.warn('Aktiva extraction failed, continuing without', { error: aktivaResult.reason instanceof Error ? aktivaResult.reason.message : String(aktivaResult.reason) });
      }

      if (anfechtungResult.status === 'fulfilled' && anfechtungResult.value) {
        result.anfechtung = anfechtungResult.value;
      } else if (anfechtungResult.status === 'rejected') {
        logger.warn('Anfechtungsanalyse failed, continuing without', { error: anfechtungResult.reason instanceof Error ? anfechtungResult.reason.message : String(anfechtungResult.reason) });
      }
    }

    report('Quellenangaben werden verifiziert… (Stufe 3/3)', 65);

    // Stage 3: Verify and correct against actual page texts + document structure
    const verifyResult = await semanticVerify(result, pageTexts, documentMap);
    result = verifyResult.result;

    // Stage 3b: Targeted re-extraction for fields removed by verifier
    // Research shows guided re-extraction recovers 5-15% of lost fields
    if (verifyResult.removedPaths.length > 0 && verifyResult.removedPaths.length <= 10) {
      report('Fehlende Felder werden nachextrahiert…', 82);
      logger.info('Targeted re-extraction', { removedPaths: verifyResult.removedPaths });
      try {
        const reExtractPrompt = `Du bist ein Extraktionsassistent. Die folgenden Felder wurden bei der vorherigen Extraktion als fehlerhaft erkannt und entfernt. Prüfe die Akte erneut SORGFÄLTIG und extrahiere NUR diese spezifischen Felder. Antworte mit einem JSON-Objekt das NUR die gefundenen Felder enthält (Pfad als Key, {wert, quelle} als Value). Wenn ein Feld wirklich nicht in der Akte steht, lasse es weg.

Gesuchte Felder: ${verifyResult.removedPaths.join(', ')}

Antworte NUR mit validem JSON: {"feldpfad": {"wert": "...", "quelle": "Seite X, ..."}, ...}`;

        const relevantPages = pageTexts.map((t, i) => `=== SEITE ${i + 1} ===\n${t}`).join('\n\n');
        const reContent = `${reExtractPrompt}\n\n${relevantPages}`;

        const reResponse = await callWithRetry(() => anthropic.messages.create({
          model: config.UTILITY_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: 'user' as const, content: reContent }],
        }));
        const reText = reResponse.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text)
          .join('');

        const reJson = extractJsonFromText(reText);
        const reParsed = JSON.parse(reJson) as Record<string, { wert: unknown; quelle: string }>;

        let recovered = 0;
        for (const [path, value] of Object.entries(reParsed)) {
          if (!value?.wert || !value?.quelle) continue;
          // Navigate to the field and set it
          const parts = path.split('.');
          let obj: unknown = result;
          for (let i = 0; i < parts.length - 1; i++) {
            if (obj && typeof obj === 'object') obj = (obj as Record<string, unknown>)[parts[i]];
            else break;
          }
          if (obj && typeof obj === 'object') {
            const lastKey = parts[parts.length - 1];
            const field = (obj as Record<string, unknown>)[lastKey];
            if (field && typeof field === 'object' && 'wert' in (field as object)) {
              const f = field as { wert: unknown; quelle: string; verifiziert?: boolean };
              f.wert = value.wert;
              f.quelle = value.quelle;
              f.verifiziert = undefined; // Needs re-verification
              recovered++;
            }
          }
        }

        if (recovered > 0) {
          logger.info(`Targeted re-extraction recovered ${recovered}/${verifyResult.removedPaths.length} fields`);
        }
      } catch (reErr) {
        logger.warn('Targeted re-extraction failed', { error: reErr instanceof Error ? reErr.message : String(reErr) });
      }
    }

    // Stage 4: Enrichment Review — catch inference errors that pure extraction misses
    // Separates "what does the document literally say?" from "what does it mean?"
    // Targets specific known error patterns: address disambiguation, date selection, classification
    report('Plausibilitätsprüfung…', 88);
    try {
      result = await enrichmentReview(result, pageTexts);
    } catch (err) {
      logger.warn('Enrichment review failed, continuing without', { error: err instanceof Error ? err.message : String(err) });
    }

    report('Nachbearbeitung…', 89);
    result = postProcessDefaults(result);

    report('Standardanschreiben werden geprüft…', 90);
    result = validateLettersAgainstChecklists(result);

    const processingTimeMs = Date.now() - startTime;
    const stats = computeStats(result);

    db.prepare(
      `UPDATE extractions SET
        result_json = ?, status = 'completed',
        stats_found = ?, stats_missing = ?, stats_letters_ready = ?,
        processing_time_ms = ?
      WHERE id = ?`
    ).run(
      writeResultJson(result),
      stats.found, stats.missing, stats.lettersReady,
      processingTimeMs,
      extractionId
    );

    logger.info('Extraktion abgeschlossen', {
      extractionId,
      found: stats.found,
      missing: stats.missing,
      lettersReady: stats.lettersReady,
      processingTimeMs,
    });

    return { id: extractionId, result, stats, processingTimeMs };
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    db.prepare(
      `UPDATE extractions SET status = 'failed', error_message = ?, processing_time_ms = ? WHERE id = ?`
    ).run(errorMessage, processingTimeMs, extractionId);

    logger.error('Extraktion fehlgeschlagen', { extractionId, error: errorMessage });
    throw error;
  }
  } finally {
    // Restore original model after pro mode
    if (modelOverride) {
      (config as Record<string, unknown>).EXTRACTION_MODEL = originalModel;
    }
  }
}
