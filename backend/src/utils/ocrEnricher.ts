/**
 * OCR enrichment for focused extraction passes.
 *
 * Builds enriched page content from Azure DI OCR results:
 * - Clean line text (always)
 * - Structured table data (rows/columns, not linearized)
 * - Low-confidence word warnings (DokumenteAnalyse V3 thresholds)
 *
 * IMPORTANT: This is for FOCUSED PASSES ONLY (10-30 pages).
 * Never use for the base extraction prompt with all pages — that caused
 * catastrophic prompt bloat (75K extra tokens on 76 pages with 129 tables).
 *
 * Ported from internal/DokumenteAnalyse V3 confidence-aware text building.
 */

import type { OcrResult } from '../services/ocrService';

/**
 * Build enriched page text from OCR result for a specific page.
 * Returns clean text + structured tables + confidence warnings.
 */
function buildEnrichedPageText(ocrResult: OcrResult, pageNumber: number): string {
  const page = ocrResult.pages.find(p => p.pageNumber === pageNumber);
  if (!page) return '';

  const parts: string[] = [];

  // 1. Clean line text (always present)
  parts.push(page.text);

  // 2. Structured tables (if any) — much more reliable than linearized OCR text
  if (page.tables && page.tables.length > 0) {
    parts.push('');
    parts.push('## Tabellen (strukturiert)');
    for (let ti = 0; ti < page.tables.length; ti++) {
      const table = page.tables[ti];
      parts.push(`Tabelle ${ti + 1} (${table.rowCount}×${table.columnCount}):`);

      // Build row-by-row text representation
      for (let row = 0; row < table.rowCount; row++) {
        const cells = table.cells
          .filter(c => c.rowIndex === row)
          .sort((a, b) => a.columnIndex - b.columnIndex);
        const rowText = cells.map(c => {
          const prefix = c.kind === 'columnHeader' ? '[H] ' : '';
          return `${prefix}${c.content}`;
        }).join(' | ');
        parts.push(`  ${rowText}`);
      }
    }
  }

  // 3. Confidence warnings (DokumenteAnalyse V3 thresholds: 0.95 auto-accept, 0.80 flag, <0.80 reject)
  const lowWords = (page.lowConfidenceWords || []).filter(w => w.confidence < 0.80);
  if (page.avgConfidence && page.avgConfidence < 0.95 && lowWords.length > 0) {
    parts.push('');
    parts.push(`## OCR-Qualität: ${(page.avgConfidence * 100).toFixed(0)}%`);
    const wordList = lowWords.slice(0, 15).map(w =>
      `"${w.text}" (${(w.confidence * 100).toFixed(0)}%)`
    ).join(', ');
    parts.push(`Unsichere Wörter: ${wordList}`);
  }

  return parts.join('\n');
}

/**
 * Build enriched page block for a set of pages.
 * Used by focused extractors (forderungen, aktiva, anfechtung) when OCR data is available.
 *
 * @param ocrResult - Full OCR result with tables and confidence data
 * @param pageNumbers - 1-based page numbers to include
 * @param plainPageTexts - Fallback plain text (used if OCR result doesn't have the page)
 * @returns Enriched page block string
 */
export function buildEnrichedPageBlock(
  ocrResult: OcrResult | null,
  pageNumbers: number[],
  plainPageTexts: string[],
): string {
  return pageNumbers.map(pageNum => {
    const header = `=== SEITE ${pageNum} ===`;
    if (ocrResult) {
      const enriched = buildEnrichedPageText(ocrResult, pageNum);
      if (enriched) return `${header}\n${enriched}`;
    }
    // Fallback to plain text
    return `${header}\n${plainPageTexts[pageNum - 1] ?? ''}`;
  }).join('\n\n');
}

/**
 * Estimate additional token cost of enrichment for a page set.
 * Used to decide whether enrichment fits within the token budget.
 */
export function estimateEnrichmentTokens(ocrResult: OcrResult, pageNumbers: number[]): number {
  let extraChars = 0;
  for (const pageNum of pageNumbers) {
    const page = ocrResult.pages.find(p => p.pageNumber === pageNum);
    if (!page) continue;
    // Table cells add structured text
    for (const table of (page.tables || [])) {
      for (const cell of table.cells) {
        extraChars += cell.content.length + 10; // cell content + formatting
      }
    }
    // Confidence warnings are minimal
    extraChars += 200;
  }
  return Math.ceil(extraChars / 2.5);
}
