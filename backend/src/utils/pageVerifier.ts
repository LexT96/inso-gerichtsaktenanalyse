/**
 * Post-extraction page reference verification.
 * Walks an ExtractionResult, checks each {wert, quelle} field against
 * actual page texts, and sets verifiziert / corrects page numbers.
 */

import { ExtractionResult } from '../../types/extraction';
import { parsePageNumber, replacePageNumber } from './pageParser';
import { fuzzyFindInText } from './fuzzyMatch';
import { logger } from './logger';

interface SourcedField {
  wert: unknown;
  quelle: string;
  verifiziert?: boolean;
}

/**
 * Check if an object looks like a sourced field ({wert, quelle}).
 */
function isSourcedField(obj: unknown): obj is SourcedField {
  if (obj === null || obj === undefined || typeof obj !== 'object') return false;
  return 'wert' in obj && 'quelle' in obj;
}

/**
 * Recursively find all sourced fields in an object.
 */
function findSourcedFields(obj: unknown, fields: SourcedField[]): void {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;

  if (isSourcedField(obj)) {
    fields.push(obj);
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      findSourcedFields(item, fields);
    }
    return;
  }

  for (const value of Object.values(obj as Record<string, unknown>)) {
    findSourcedFields(value, fields);
  }
}

/**
 * Convert a wert to a string for fuzzy matching.
 * Returns null if the value is not matchable.
 */
function wertToString(wert: unknown): string | null {
  if (wert === null || wert === undefined) return null;
  if (typeof wert === 'string') return wert.trim() || null;
  if (typeof wert === 'number') return String(wert);
  if (typeof wert === 'boolean') return String(wert);
  return null;
}

/**
 * Verify all page references in an ExtractionResult against actual page texts.
 *
 * For each sourced field with a non-empty wert and a page reference in quelle:
 * - If the value is found on the referenced page → verifiziert = true
 * - If found on a different page → correct quelle, verifiziert = true
 * - If not found anywhere → verifiziert = false
 *
 * Fields with null/empty wert or no page reference are skipped.
 *
 * @param result - The extraction result to verify (mutated in place)
 * @param pageTexts - Array of page text strings (index 0 = page 1)
 * @returns The same result object with verifiziert flags set
 */
export function verifyPageReferences(
  result: ExtractionResult,
  pageTexts: string[]
): ExtractionResult {
  const fields: SourcedField[] = [];
  findSourcedFields(result, fields);

  let verified = 0;
  let corrected = 0;
  let failed = 0;
  let skipped = 0;

  for (const field of fields) {
    const valueStr = wertToString(field.wert);
    if (!valueStr) {
      skipped++;
      continue;
    }

    const pageNum = parsePageNumber(field.quelle);
    if (pageNum === null) {
      skipped++;
      continue;
    }

    const pageIndex = pageNum - 1;

    // Check referenced page first
    if (pageIndex >= 0 && pageIndex < pageTexts.length) {
      if (fuzzyFindInText(valueStr, pageTexts[pageIndex])) {
        field.verifiziert = true;
        verified++;
        continue;
      }
    }

    // Search all other pages
    let foundOnPage: number | null = null;
    for (let i = 0; i < pageTexts.length; i++) {
      if (i === pageIndex) continue;
      if (fuzzyFindInText(valueStr, pageTexts[i])) {
        foundOnPage = i + 1; // 1-based page number
        break;
      }
    }

    if (foundOnPage !== null) {
      field.quelle = replacePageNumber(field.quelle, foundOnPage);
      field.verifiziert = true;
      corrected++;
    } else {
      field.verifiziert = false;
      failed++;
    }
  }

  logger.info('Page verification complete', {
    total: fields.length,
    verified,
    corrected,
    failed,
    skipped,
  });

  return result;
}
