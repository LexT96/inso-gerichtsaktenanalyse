/**
 * Manual verification script for the new image-batched handwriting mode.
 *
 * Forces anthropicSupportsNativePdf() to return false (simulating Langdock),
 * then exercises extractHandwrittenFormFields on a real PDF + OCR from a
 * completed extraction. Prints mode used, merged field count, and the
 * actual recognized values.
 *
 * Usage: npx tsx src/scripts/test-image-batched-handwriting.ts <extraction-id>
 *
 * Costs a real Anthropic API call (~0.30-0.50 EUR for a 22-page Fragebogen).
 */

import '../env';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const extractionId = parseInt(process.argv[2] ?? '', 10);
if (isNaN(extractionId)) {
  console.error('Usage: npx tsx src/scripts/test-image-batched-handwriting.ts <extraction-id>');
  process.exit(1);
}

async function main() {
  console.log(`\n=== image-batched handwriting verification — extraction ${extractionId} ===\n`);

  // Force the Langdock-style fallback path even though we're on direct Anthropic locally.
  process.env.FORCE_NO_NATIVE_PDF = '1';

  const extractionProvider = await import('../services/extractionProvider');
  console.log(`FORCE_NO_NATIVE_PDF=1; anthropicSupportsNativePdf() => ${extractionProvider.anthropicSupportsNativePdf()}\n`);

  // STEP 2: now load the other modules — they'll pick up the mutated helper
  const { readResultJson } = await import('../db/resultJson');
  const { extractHandwrittenFormFields } = await import('../services/extraction');
  const { extractTextPerPage } = await import('../services/pdfProcessor');
  type ExtractionResult = import('../types/extraction').ExtractionResult;

  const dbPath = process.env.DATABASE_PATH || './data/insolvenz.db';
  const pdfDir = path.join(path.resolve(path.dirname(dbPath), 'pdfs'), String(extractionId));
  const pdfPath = path.join(pdfDir, '0_gerichtsakte.pdf');

  if (!fs.existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`);
    process.exit(1);
  }

  const pdfBuffer = fs.readFileSync(pdfPath);
  console.log(`Loaded PDF: ${pdfPath} (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT result_json FROM extractions WHERE id = ?').get(extractionId) as { result_json: string } | undefined;
  db.close();
  if (!row?.result_json) {
    console.error('No result_json for this extraction');
    process.exit(1);
  }
  const existingResult = readResultJson<ExtractionResult>(row.result_json);
  if (!existingResult) {
    console.error('Failed to parse result_json');
    process.exit(1);
  }

  const HANDWRITING_FIELDS = [
    'name', 'vorname', 'geburtsdatum', 'geburtsort', 'geburtsland', 'staatsangehoerigkeit',
    'telefon', 'mobiltelefon', 'email', 'aktuelle_adresse',
    'betriebsstaette_adresse', 'geschaeftszweig', 'unternehmensgegenstand', 'firma',
    'finanzamt', 'steuernummer', 'ust_id', 'steuerberater',
    'sozialversicherungstraeger', 'letzter_jahresabschluss', 'bankverbindungen',
    'familienstand', 'geschlecht',
  ];
  const before: Record<string, unknown> = {};
  const schuldner = existingResult.schuldner as unknown as Record<string, { wert: unknown; quelle: string } | undefined>;
  for (const f of HANDWRITING_FIELDS) {
    const cur = schuldner[f];
    before[f] = cur?.wert ?? null;
    if (cur) cur.wert = '' as never;
  }

  console.log(`Reset ${HANDWRITING_FIELDS.length} handwriting-target fields to empty.`);
  console.log(`Re-extracting pageTexts from PDF (fresh pymupdf read)...\n`);

  const pageTexts = await extractTextPerPage(pdfBuffer);
  console.log(`pageTexts: ${pageTexts.length} pages\n`);

  console.log(`Running extractHandwrittenFormFields with image-batched forced...`);
  console.log(`(Watch backend/data/logs/insolvenz-*.log for real-time progress)\n`);
  const start = Date.now();
  const outcome = await extractHandwrittenFormFields(existingResult, pdfBuffer, pageTexts);
  const durationMs = Date.now() - start;

  const after = outcome.result.schuldner as unknown as Record<string, { wert: unknown; quelle: string } | undefined>;

  console.log(`\n=== result after ${(durationMs / 1000).toFixed(1)}s ===\n`);
  console.log(`ocrEntriesAdded: ${outcome.ocrEntriesAdded}\n`);
  console.log('Field                          | before           | after');
  console.log('-------------------------------|------------------|------------------');
  let mergedCount = 0;
  for (const f of HANDWRITING_FIELDS) {
    const b = String(before[f] ?? '').slice(0, 16).padEnd(16);
    const a = String(after[f]?.wert ?? '').slice(0, 40);
    const merged = String(after[f]?.quelle ?? '').includes('Handschrift-Extraktion');
    if (merged) mergedCount++;
    console.log(`${f.padEnd(30)} | ${b} | ${a}${merged ? '  ★' : ''}`);
  }
  console.log();
  console.log(`Merged via handwriting pass: ${mergedCount} fields (★)`);
}

main().catch(err => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
