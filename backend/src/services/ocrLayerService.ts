/**
 * OCR text layer service.
 * Adds invisible searchable text to scanned PDFs using Azure DI word positions.
 * The frontend PDF viewer can then highlight and search text in scanned documents.
 *
 * Uses pymupdf (fitz) to overlay invisible text at the exact word positions
 * returned by Azure Document Intelligence.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';
import type { OcrResult } from './ocrService';

/**
 * Add an invisible OCR text layer to a scanned PDF.
 * Returns a new PDF buffer with searchable text overlaid on each page.
 *
 * @param pdfBuffer - Original scanned PDF
 * @param ocrResult - Azure DI OCR result with word-level polygon positions
 * @returns New PDF buffer with text layer, or original if OCR data insufficient
 */
export function addOcrTextLayer(pdfBuffer: Buffer, ocrResult: OcrResult): Buffer {
  // Check if we have word positions
  const pagesWithPolygons = ocrResult.pages.filter(p =>
    p.wordConfidences?.some(w => w.polygon && w.polygon.length >= 8)
  );

  if (pagesWithPolygons.length === 0) {
    logger.info('No word polygon data available, skipping OCR text layer');
    return pdfBuffer;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-layer-'));
  const inputPath = path.join(tmpDir, 'input.pdf');
  const outputPath = path.join(tmpDir, 'output.pdf');
  const wordsPath = path.join(tmpDir, 'words.json');

  try {
    fs.writeFileSync(inputPath, pdfBuffer);

    // Build words data for Python script: per-page array of {text, x, y, w, h}
    const wordsData: Array<Array<{ text: string; x: number; y: number; w: number; h: number }>> = [];

    for (const page of ocrResult.pages) {
      const pageWords: Array<{ text: string; x: number; y: number; w: number; h: number }> = [];

      for (const word of (page.wordConfidences || [])) {
        if (!word.polygon || word.polygon.length < 8) continue;
        // Azure DI polygon: [x1,y1, x2,y2, x3,y3, x4,y4] in inches
        // Convert to x, y (top-left), w, h for pymupdf (which uses points = inches * 72)
        const [x1, y1, x2, , , y3] = word.polygon;
        const x = x1 * 72;
        const y = y1 * 72;
        const w = (x2 - x1) * 72;
        const h = (y3 - y1) * 72;

        if (w > 0 && h > 0) {
          pageWords.push({ text: word.text, x, y, w, h });
        }
      }

      wordsData.push(pageWords);
    }

    fs.writeFileSync(wordsPath, JSON.stringify(wordsData));

    // Python script: overlay invisible text at word positions
    const script = `
import fitz
import json
import sys

doc = fitz.open(sys.argv[1])
words = json.load(open(sys.argv[3]))

for page_idx in range(len(doc)):
    if page_idx >= len(words):
        break
    page = doc[page_idx]
    page_words = words[page_idx]

    for w in page_words:
        rect = fitz.Rect(w['x'], w['y'], w['x'] + w['w'], w['y'] + w['h'])
        # Font size: fit text height to bounding box
        fontsize = max(1, w['h'] * 0.85)
        # Insert invisible text (render_mode=3 = invisible)
        rc = page.insert_text(
            fitz.Point(rect.x0, rect.y1 - 1),
            w['text'],
            fontsize=fontsize,
            render_mode=3,  # invisible
        )

doc.save(sys.argv[2])
doc.close()
`;

    execFileSync('python3', ['-c', script, inputPath, outputPath, wordsPath], {
      timeout: 60_000,
    });

    if (fs.existsSync(outputPath)) {
      const result = fs.readFileSync(outputPath);
      logger.info('OCR text layer added', {
        pages: pagesWithPolygons.length,
        totalWords: wordsData.reduce((s, p) => s + p.length, 0),
        originalSize: pdfBuffer.length,
        newSize: result.length,
      });
      return result;
    }

    return pdfBuffer;
  } catch (err) {
    logger.warn('Failed to add OCR text layer', {
      error: err instanceof Error ? err.message : String(err),
    });
    return pdfBuffer;
  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  }
}
