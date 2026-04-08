#!/usr/bin/env npx tsx
/**
 * Promptfoo script provider for TBS extraction pipeline.
 *
 * Called by promptfoo via: exec: npx tsx backend/src/scripts/promptfoo-provider.ts
 * Receives: prompt (PDF path), options (JSON), context (JSON) as CLI args.
 * Outputs: ExtractionResult JSON to stdout.
 */

// Suppress ALL stdout before anything loads (dotenv tips, winston console, pdf-parse warnings)
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;

// Force test DB and quiet logging before any module reads them
process.env.DATABASE_PATH = './data/insolvenz-promptfoo-test.db';
process.env.LOG_LEVEL = 'error';

async function main() {
  // Dynamic imports — these run AFTER stdout is suppressed
  await import('../env');
  const fs = await import('fs');
  const path = await import('path');
  const { initDatabase, getDb } = await import('../db/database');

  const prompt = process.argv[2] ?? '';
  const pdfPath = path.resolve(prompt.trim());

  if (!fs.existsSync(pdfPath)) {
    process.stdout.write = originalStdoutWrite;
    console.error(`PDF not found: ${pdfPath}`);
    process.exit(1);
  }

  // Initialize test DB and seed a test user
  initDatabase(process.env.DATABASE_PATH!);
  const db = getDb();
  const existingUser = db.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!existingUser) {
    db.prepare(
      'INSERT INTO users (id, username, password_hash, display_name, role) VALUES (1, ?, ?, ?, ?)'
    ).run('promptfoo-test', 'not-a-real-hash', 'Promptfoo Test', 'admin');
  }

  const pdfBuffer = Buffer.from(fs.readFileSync(pdfPath));
  const filename = path.basename(pdfPath);

  const { processExtraction } = await import('../services/extraction');

  const { result } = await processExtraction(
    pdfBuffer,
    filename,
    pdfBuffer.length,
    1, // userId (dummy for testing)
  );

  // Restore stdout and write ONLY the JSON result
  process.stdout.write = originalStdoutWrite;
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  process.stdout.write = originalStdoutWrite;
  console.error(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
