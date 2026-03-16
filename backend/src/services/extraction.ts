import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { extractFromPdfBuffer, extractFromPageTexts } from './anthropic';
import { extractTextPerPage } from './pdfProcessor';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { analyzeDocumentStructure } from '../utils/documentAnalyzer';
import { semanticVerify } from '../utils/semanticVerifier';
import type { ExtractionResult } from '../types/extraction';

const PDF_DOCUMENT_PAGE_LIMIT = 100;

function isAnthropicApiError(err: unknown): boolean {
  return err instanceof Anthropic.APIError;
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

export async function processExtraction(
  filePath: string,
  filename: string,
  fileSize: number,
  userId: number
): Promise<{ id: number; result: ExtractionResult; stats: ExtractionStats; processingTimeMs: number }> {
  const db = getDb();
  const startTime = Date.now();

  // Create extraction record
  const insertResult = db.prepare(
    'INSERT INTO extractions (user_id, filename, file_size, status) VALUES (?, ?, ?, ?)'
  ).run(userId, filename, fileSize, 'processing');
  const extractionId = Number(insertResult.lastInsertRowid);

  try {
    const pdfBuffer = fs.readFileSync(filePath);

    // Always extract text per page — needed for analysis and verification
    const pageTexts = await extractTextPerPage(pdfBuffer);
    const pageCount = pageTexts.length;
    logger.info('PDF Seitenanzahl ermittelt', { pageCount });

    // Stage 1: Analyze document structure
    const documentMap = await analyzeDocumentStructure(pageTexts);

    // Stage 2: Extract data with document context
    let result: ExtractionResult;

    if (pageCount > PDF_DOCUMENT_PAGE_LIMIT) {
      // Large PDF: process in chunks
      logger.info('Großes PDF — verwende seitenbasiertes Chunking', { pageCount });
      result = await extractFromPageTexts(pageTexts, documentMap);
    } else {
      // Small PDF: send as native document for best quality
      try {
        result = await extractFromPdfBuffer(pdfBuffer, documentMap);
      } catch (primaryError) {
        // Do NOT fall back on rate limit or auth errors — they will fail again
        if (isAnthropicApiError(primaryError)) {
          throw primaryError;
        }
        logger.warn('PDF-Dokument-Modus fehlgeschlagen, versuche seitenbasierten Text-Fallback', {
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        });
        result = await extractFromPageTexts(pageTexts, documentMap);
      }
    }

    // Stage 3: Verify and correct against actual page texts + document structure
    result = await semanticVerify(result, pageTexts, documentMap);

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
      JSON.stringify(result),
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
  } finally {
    // Always delete the uploaded file
    try {
      fs.unlinkSync(filePath);
      logger.info('Upload-Datei gelöscht', { filePath });
    } catch {
      logger.warn('Upload-Datei konnte nicht gelöscht werden', { filePath });
    }
  }
}
