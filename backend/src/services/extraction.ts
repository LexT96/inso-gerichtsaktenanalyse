import Anthropic from '@anthropic-ai/sdk';
import { extractFromPdfBuffer, extractFromPageTexts } from './anthropic';
import { extractTextPerPage } from './pdfProcessor';
import { getDb } from '../db/database';
import { writeResultJson } from '../db/resultJson';
import { logger } from '../utils/logger';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { analyzeDocumentStructure } from '../utils/documentAnalyzer';
import { semanticVerify } from '../utils/semanticVerifier';
import type { ExtractionResult } from '../types/extraction';

const PDF_DOCUMENT_PAGE_LIMIT = 100;

function isUnrecoverableApiError(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    err instanceof Anthropic.AuthenticationError
  );
}

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
  onProgress?: ProgressCallback
): Promise<{ id: number; result: ExtractionResult; stats: ExtractionStats; processingTimeMs: number }> {
  const report = onProgress ?? (() => {});
  const db = getDb();
  const startTime = Date.now();

  // Create extraction record
  const insertResult = db.prepare(
    'INSERT INTO extractions (user_id, filename, file_size, status) VALUES (?, ?, ?, ?)'
  ).run(userId, filename, fileSize, 'processing');
  const extractionId = Number(insertResult.lastInsertRowid);

  try {
    report('Seitentext wird extrahiert…', 8);

    // Always extract text per page — needed for analysis and verification
    const pageTexts = await extractTextPerPage(pdfBuffer);
    const pageCount = pageTexts.length;
    logger.info('PDF Seitenanzahl ermittelt', { pageCount });

    report(`${pageCount} Seiten erkannt — Dokumentstruktur wird analysiert… (Stufe 1/3)`, 15);

    // Stage 1: Analyze document structure
    const documentMap = await analyzeDocumentStructure(pageTexts);

    report('Daten werden extrahiert… (Stufe 2/3)', 30);

    // Stage 2: Extract data with document context
    let result: ExtractionResult;

    if (pageCount > PDF_DOCUMENT_PAGE_LIMIT) {
      logger.info('Großes PDF — verwende seitenbasiertes Chunking', { pageCount });
      report(`Großes PDF (${pageCount} S.) — Chunked Extraktion… (Stufe 2/3)`, 35);
      result = await extractFromPageTexts(pageTexts, documentMap);
    } else {
      // Try native PDF mode first (best quality). Falls back to text-based
      // extraction if the provider doesn't support the 'document' content type.
      try {
        result = await extractFromPdfBuffer(pdfBuffer, documentMap);
      } catch (primaryError) {
        if (isUnrecoverableApiError(primaryError)) {
          throw primaryError;
        }
        logger.warn('PDF-Dokument-Modus fehlgeschlagen, versuche seitenbasierten Text-Fallback', {
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        });
        report('Fallback auf textbasierte Extraktion…', 45);
        result = await extractFromPageTexts(pageTexts, documentMap);
      }
    }

    report('Quellenangaben werden verifiziert… (Stufe 3/3)', 65);

    // Stage 3: Verify and correct against actual page texts + document structure
    result = await semanticVerify(result, pageTexts, documentMap);

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
}
