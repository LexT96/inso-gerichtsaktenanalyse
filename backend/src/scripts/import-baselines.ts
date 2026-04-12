#!/usr/bin/env npx tsx
/**
 * One-shot script to import existing Sonnet extraction results as benchmark baselines.
 */

import '../env';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import { initDatabase, getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import { saveBenchmarkRun, computeDocumentHash } from '../services/benchmarkService';

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_PATH || './data/insolvenz.db');
  const db = getDb();

  // 1. Import Eilers extraction #113 (Sonnet + OCR, scanned PDF)
  const row113 = db.prepare('SELECT result_json, processing_time_ms FROM extractions WHERE id = 113').get() as any;
  if (row113) {
    const result113 = readResultJson(row113.result_json);
    const eilersPdf = fs.readFileSync('/Users/thorsten/Downloads/Gerichtsakte.pdf');
    const eilersHash = computeDocumentHash(eilersPdf);

    const id1 = saveBenchmarkRun({
      documentName: 'Eilers-Verbraucherinsolvenz',
      documentHash: eilersHash,
      documentPages: 76,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      reasoningEnabled: false,
      extractionTimeMs: row113.processing_time_ms,
      result: result113,
      notes: 'Sonnet baseline with Azure DI OCR (scanned PDF)',
    });
    console.log(`Eilers Sonnet imported as benchmark #${id1}`);
  } else {
    console.log('Extraction #113 not found, skipping Eilers');
  }

  // 2. Import Geldt CNC Technik (gutes Beispiel) existing JSON
  const geldtJsonPath = '/Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/testdokumente/Gerichtsakte (gutes Beispiel)-extraction.json';
  const geldtPdfPath = '/Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/testdokumente/Gerichtsakte (gutes Beispiel).pdf';

  if (fs.existsSync(geldtJsonPath) && fs.existsSync(geldtPdfPath)) {
    const geldtJson = JSON.parse(fs.readFileSync(geldtJsonPath, 'utf-8'));
    const geldtPdf = fs.readFileSync(geldtPdfPath);
    const geldtHash = computeDocumentHash(geldtPdf);
    const geldtDoc = await PDFDocument.load(geldtPdf, { ignoreEncryption: true });

    const id2 = saveBenchmarkRun({
      documentName: 'Geldt-CNC-Technik',
      documentHash: geldtHash,
      documentPages: geldtDoc.getPageCount(),
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      reasoningEnabled: false,
      extractionTimeMs: 0,
      result: geldtJson,
      notes: 'Sonnet baseline (imported from existing extraction JSON)',
    });
    console.log(`Geldt Sonnet imported as benchmark #${id2}`);
  } else {
    console.log('Geldt files not found, skipping');
  }

  console.log('\nDone. Run `npm run benchmark:list` to see results.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
