#!/usr/bin/env npx tsx
/** Test: verify OCR text layer generation on a scanned PDF */
import '../env';
import fs from 'fs';
import { ocrPdf } from '../services/ocrService';
import { addOcrTextLayer } from '../services/ocrLayerService';

async function main() {
  const pdfPath = process.argv[2] || '/Users/thorsten/Downloads/Gerichtsakte.pdf';
  const pdf = fs.readFileSync(pdfPath);
  console.log('PDF size:', pdf.length);

  const ocr = await ocrPdf(pdf);
  const withPolygons = ocr.pages.filter(p => p.wordConfidences?.some(w => w.polygon && w.polygon.length >= 8));
  console.log('Pages with polygons:', withPolygons.length, '/', ocr.pages.length);

  if (withPolygons.length === 0) {
    console.log('No polygon data — need fresh OCR. Delete the cache file and re-run.');
    return;
  }

  const result = addOcrTextLayer(pdf, ocr);
  console.log('Output size:', result.length);

  const outPath = '/tmp/test-ocr-layer.pdf';
  fs.writeFileSync(outPath, result);
  console.log(`Saved to ${outPath} — open to verify text selection works`);
}

main().catch(console.error);
