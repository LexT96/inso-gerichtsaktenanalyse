#!/usr/bin/env npx tsx
/**
 * Benchmark CLI — run extractions and persist results for model comparison.
 *
 * Usage:
 *   npx tsx src/scripts/benchmark.ts <path-to-pdf>              # Run extraction + save
 *   npx tsx src/scripts/benchmark.ts <path-to-pdf> --notes="..."  # With notes
 *   npx tsx src/scripts/benchmark.ts --list                      # Show all runs
 *   npx tsx src/scripts/benchmark.ts --list --doc=<hash>         # Filter by document
 *   npx tsx src/scripts/benchmark.ts --compare=<id1>,<id2>       # Compare two runs
 *   npx tsx src/scripts/benchmark.ts --import-json=<path> --doc-pdf=<pdf-path>  # Import existing result
 *
 * Environment:
 *   Uses current .env settings for provider/model selection.
 *   EXTRACTION_PROVIDER, EXTRACTION_MODEL, OPENAI_MODEL etc.
 */

import '../env';
import fs from 'fs';
import path from 'path';
import { initDatabase } from '../db/database';
import {
  saveBenchmarkRun,
  listBenchmarkRuns,
  compareBenchmarkRuns,
  computeDocumentHash,
} from '../services/benchmarkService';
import { detectProvider, getExtractionModel } from '../services/extractionProvider';
import type { ExtractionResult } from '../types/extraction';

function parseArgs(): {
  pdfPath?: string;
  list: boolean;
  docFilter?: string;
  compare?: [number, number];
  importJson?: string;
  docPdf?: string;
  notes?: string;
} {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = { list: false };

  for (const arg of args) {
    if (arg === '--list') result.list = true;
    else if (arg.startsWith('--doc=')) result.docFilter = arg.split('=')[1];
    else if (arg.startsWith('--compare=')) {
      const [a, b] = arg.split('=')[1].split(',').map(Number);
      result.compare = [a, b];
    }
    else if (arg.startsWith('--import-json=')) result.importJson = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--doc-pdf=')) result.docPdf = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--notes=')) result.notes = arg.split('=').slice(1).join('=');
    else if (!arg.startsWith('--')) result.pdfPath = arg;
  }

  return result;
}

function printRunsTable(runs: ReturnType<typeof listBenchmarkRuns>): void {
  if (runs.length === 0) {
    console.log('Keine Benchmark-Runs gefunden.\n');
    return;
  }

  // Group by document
  const byDoc = new Map<string, typeof runs>();
  for (const r of runs) {
    const key = r.document_name;
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key)!.push(r);
  }

  for (const [docName, docRuns] of byDoc) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`  ${docName} (${docRuns[0].document_pages} Seiten, Hash: ${docRuns[0].document_hash})`);
    console.log('═'.repeat(80));

    // Header
    const hdr = [
      'ID'.padStart(4),
      'Modell'.padEnd(25),
      'Provider'.padEnd(10),
      'Think'.padEnd(5),
      'Felder'.padEnd(12),
      'Rate'.padEnd(6),
      'Ford.'.padStart(5),
      'Akt.'.padStart(5),
      'Anf.'.padStart(5),
      'Zeit'.padEnd(8),
      'Tokens'.padEnd(14),
      'Datum'.padEnd(16),
    ].join(' │ ');
    console.log(hdr);
    console.log('─'.repeat(hdr.length));

    for (const r of docRuns) {
      const reasoning = r.reasoning_enabled ? (r.reasoning_effort || 'yes') : '—';
      const fields = `${r.fields_found}/${r.fields_total}`;
      const rate = `${(r.field_rate * 100).toFixed(0)}%`;
      const timeStr = r.extraction_time_ms > 60000
        ? `${(r.extraction_time_ms / 60000).toFixed(1)}m`
        : `${(r.extraction_time_ms / 1000).toFixed(0)}s`;
      const tokens = r.input_tokens != null
        ? `${Math.round((r.input_tokens + (r.output_tokens ?? 0)) / 1000)}K`
        : '—';
      const date = r.created_at.substring(0, 16);

      console.log([
        String(r.id).padStart(4),
        r.model.padEnd(25),
        r.provider.padEnd(10),
        reasoning.padEnd(5),
        fields.padEnd(12),
        rate.padEnd(6),
        String(r.einzelforderungen_count).padStart(5),
        String(r.aktiva_count).padStart(5),
        String(r.anfechtung_count).padStart(5),
        timeStr.padEnd(8),
        tokens.padEnd(14),
        date.padEnd(16),
      ].join(' │ '));
    }
  }
  console.log('');
}

function printComparison(runIdA: number, runIdB: number): void {
  const diffs = compareBenchmarkRuns(runIdA, runIdB);
  const changed = diffs.filter(d => d.filled_a !== d.filled_b || (d.filled_a && d.filled_b && d.value_a !== d.value_b));

  console.log(`\nVergleich Run #${runIdA} vs #${runIdB}:`);
  console.log(`  Gesamt: ${diffs.length} Felder, ${changed.length} Unterschiede\n`);

  if (changed.length === 0) {
    console.log('  Keine Unterschiede in der Feldabdeckung.\n');
    return;
  }

  const hdr = ['Feld'.padEnd(35), `#${runIdA}`.padEnd(30), `#${runIdB}`.padEnd(30)].join(' │ ');
  console.log(hdr);
  console.log('─'.repeat(hdr.length));

  for (const d of changed) {
    const a = d.filled_a ? (d.value_a ?? '(leer)') : '—';
    const b = d.filled_b ? (d.value_b ?? '(leer)') : '—';
    const indicator = d.filled_a && !d.filled_b ? ' ✗' : !d.filled_a && d.filled_b ? ' ✓' : ' ≠';
    console.log([
      (d.label + indicator).padEnd(35),
      a.substring(0, 30).padEnd(30),
      b.substring(0, 30).padEnd(30),
    ].join(' │ '));
  }
  console.log('');
}

async function runBenchmark(pdfPath: string, notes?: string): Promise<void> {
  const resolvedPath = path.resolve(pdfPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`PDF nicht gefunden: ${resolvedPath}`);
    process.exit(1);
  }

  const pdfBuffer = fs.readFileSync(resolvedPath);
  const documentHash = computeDocumentHash(pdfBuffer);
  const documentName = path.basename(resolvedPath, '.pdf');
  const provider = detectProvider();
  const model = getExtractionModel();

  console.log(`\nBenchmark: ${documentName}`);
  console.log(`  Provider: ${provider}`);
  console.log(`  Modell: ${model}`);
  console.log(`  Hash: ${documentHash}`);
  console.log(`  Starte Extraktion...\n`);

  // Init DB (needed for extraction pipeline)
  const dbPath = process.env.DATABASE_PATH || './data/insolvenz.db';
  initDatabase(dbPath);

  const { processExtraction } = await import('../services/extraction');

  const startTime = Date.now();
  try {
    const { result, stats, processingTimeMs } = await processExtraction(
      pdfBuffer,
      path.basename(resolvedPath),
      pdfBuffer.length,
      1, // userId
      (msg, pct) => {
        process.stdout.write(`\r  [${pct}%] ${msg}`.padEnd(80));
      },
    );
    console.log('\n');

    // Count pages
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pageCount = doc.getPageCount();

    const runId = saveBenchmarkRun({
      documentName,
      documentHash,
      documentPages: pageCount,
      model,
      provider,
      reasoningEnabled: false,
      extractionTimeMs: processingTimeMs,
      result,
      notes,
    });

    const rate = stats.total > 0 ? (stats.found / stats.total * 100).toFixed(0) : '0';
    console.log(`  Benchmark #${runId} gespeichert!`);
    console.log(`  Felder: ${stats.found}/${stats.total} (${rate}%)`);
    console.log(`  Forderungen: ${result.forderungen?.einzelforderungen?.length ?? 0}`);
    console.log(`  Aktiva: ${result.aktiva?.positionen?.length ?? 0}`);
    console.log(`  Anfechtung: ${result.anfechtung?.vorgaenge?.length ?? 0}`);
    console.log(`  Zeit: ${(processingTimeMs / 1000).toFixed(1)}s`);
    console.log('');

    // Also save raw JSON for manual inspection
    const jsonPath = resolvedPath.replace(/\.pdf$/i, `-benchmark-${model}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`  Raw JSON: ${jsonPath}\n`);
  } catch (err) {
    console.error('\n  Extraktion fehlgeschlagen:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function importJsonResult(jsonPath: string, docPdfPath: string, notes?: string): Promise<void> {
  const resolvedJson = path.resolve(jsonPath);
  const resolvedPdf = path.resolve(docPdfPath);

  if (!fs.existsSync(resolvedJson)) {
    console.error(`JSON nicht gefunden: ${resolvedJson}`);
    process.exit(1);
  }
  if (!fs.existsSync(resolvedPdf)) {
    console.error(`PDF nicht gefunden: ${resolvedPdf}`);
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(resolvedJson, 'utf-8')) as ExtractionResult;
  const pdfBuffer = fs.readFileSync(resolvedPdf);
  const documentHash = computeDocumentHash(pdfBuffer);
  const documentName = path.basename(resolvedPdf, '.pdf');

  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pageCount = doc.getPageCount();

  // Try to detect model/provider from filename or notes
  const modelMatch = path.basename(resolvedJson).match(/(claude-[a-z0-9-]+|gpt-[0-9.]+|sonnet|opus|haiku)/i);
  const model = modelMatch ? modelMatch[1] : 'unknown';
  const provider = model.startsWith('gpt') ? 'openai' : 'anthropic';

  const runId = saveBenchmarkRun({
    documentName,
    documentHash,
    documentPages: pageCount,
    model,
    provider,
    reasoningEnabled: false,
    extractionTimeMs: 0,
    result,
    notes: notes ?? `Imported from ${path.basename(resolvedJson)}`,
  });

  console.log(`\n  Benchmark #${runId} importiert (${documentName}, ${model})\n`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.compare) {
    printComparison(args.compare[0], args.compare[1]);
    return;
  }

  if (args.list) {
    const runs = listBenchmarkRuns(args.docFilter);
    printRunsTable(runs);
    return;
  }

  if (args.importJson && args.docPdf) {
    await importJsonResult(args.importJson, args.docPdf, args.notes);
    return;
  }

  if (args.pdfPath) {
    await runBenchmark(args.pdfPath, args.notes);
    return;
  }

  console.log(`
Benchmark CLI — Extraktions-Modellvergleich

Verwendung:
  npx tsx src/scripts/benchmark.ts <pdf-pfad>                      # Extraktion + speichern
  npx tsx src/scripts/benchmark.ts <pdf-pfad> --notes="GPT Test"   # Mit Notiz
  npx tsx src/scripts/benchmark.ts --list                          # Alle Runs anzeigen
  npx tsx src/scripts/benchmark.ts --list --doc=<hash>             # Nach Dokument filtern
  npx tsx src/scripts/benchmark.ts --compare=1,2                   # Zwei Runs vergleichen
  npx tsx src/scripts/benchmark.ts --import-json=<json> --doc-pdf=<pdf>  # Bestehende Ergebnisse importieren

npm shortcuts:
  npm run benchmark -- <pdf-pfad>
  npm run benchmark:list
  npm run benchmark:compare -- 1,2
`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
