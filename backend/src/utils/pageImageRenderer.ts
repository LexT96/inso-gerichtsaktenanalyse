/**
 * Render PDF pages to JPEG images for use in LLM prompts.
 * Shared utility for base extraction and focused passes.
 *
 * Uses pymupdf (fitz) via python3 for rendering.
 * Caches rendered images per PDF hash + DPI to avoid re-rendering.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger';

/**
 * Render specific pages from a PDF buffer to base64 JPEG images.
 * Returns a Map of pageIndex → base64 JPEG string.
 */
export function renderPagesToJpeg(
  pdfBuffer: Buffer,
  pageIndices: number[],
  dpi = 100,
): Map<number, string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-img-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  const result = new Map<number, string>();

  try {
    const pageList = pageIndices.join(',');
    const script = `
import fitz, sys, os
doc = fitz.open(sys.argv[1])
pages = [int(p) for p in sys.argv[3].split(',') if p]
for i in pages:
    if i < len(doc):
        pix = doc[i].get_pixmap(dpi=int(sys.argv[4]))
        pix.save(os.path.join(sys.argv[2], f'page_{i:04d}.jpg'))
doc.close()
`;
    execFileSync('python3', ['-c', script, pdfPath, tmpDir, pageList, String(dpi)], { timeout: 120_000 });

    for (const pageIdx of pageIndices) {
      const imgPath = path.join(tmpDir, `page_${String(pageIdx).padStart(4, '0')}.jpg`);
      if (fs.existsSync(imgPath)) {
        result.set(pageIdx, fs.readFileSync(imgPath).toString('base64'));
      }
    }
  } catch (err) {
    logger.warn('Page image rendering failed', {
      error: err instanceof Error ? err.message : String(err),
      pages: pageIndices.length,
    });
  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  }

  return result;
}
