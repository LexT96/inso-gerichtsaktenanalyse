/**
 * Benchmark persistence service.
 * Stores extraction benchmark results in a separate SQLite DB (data/benchmarks.db).
 * Not subject to data retention — results persist permanently for comparison.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { ExtractionResult } from '../types/extraction';
import { computeExtractionStats } from '../utils/computeStats';

const BENCHMARK_DB_PATH = path.join(process.cwd(), 'data', 'benchmarks.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(BENCHMARK_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(BENCHMARK_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        -- Document identification
        document_name TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        document_pages INTEGER NOT NULL,
        -- Model / provider
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        reasoning_enabled INTEGER NOT NULL DEFAULT 0,
        reasoning_effort TEXT,
        -- Timing
        extraction_time_ms INTEGER NOT NULL,
        -- Token usage
        input_tokens INTEGER,
        output_tokens INTEGER,
        -- Field stats (from computeStats)
        fields_found INTEGER NOT NULL,
        fields_missing INTEGER NOT NULL,
        fields_total INTEGER NOT NULL,
        field_rate REAL NOT NULL,
        -- Detail counts
        einzelforderungen_count INTEGER DEFAULT 0,
        aktiva_count INTEGER DEFAULT 0,
        anfechtung_count INTEGER DEFAULT 0,
        letters_ready INTEGER DEFAULT 0,
        -- Aggregated values
        gesamtforderungen REAL,
        summe_aktiva REAL,
        gesamtpotenzial REAL,
        -- Full result for replay / detailed comparison
        result_json TEXT NOT NULL,
        -- Metadata
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),

        UNIQUE(document_hash, model, provider, reasoning_enabled)
      );

      CREATE TABLE IF NOT EXISTS benchmark_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        field_label TEXT NOT NULL,
        value TEXT,
        filled INTEGER NOT NULL,
        quelle TEXT,
        UNIQUE(run_id, field_path)
      );

      CREATE INDEX IF NOT EXISTS idx_benchmark_runs_doc ON benchmark_runs(document_hash);
      CREATE INDEX IF NOT EXISTS idx_benchmark_runs_model ON benchmark_runs(model);
      CREATE INDEX IF NOT EXISTS idx_benchmark_fields_run ON benchmark_fields(run_id);
    `);
  }
  return db;
}

export interface BenchmarkRunInput {
  documentName: string;
  documentHash: string;
  documentPages: number;
  model: string;
  provider: string;
  reasoningEnabled: boolean;
  reasoningEffort?: string;
  extractionTimeMs: number;
  inputTokens?: number;
  outputTokens?: number;
  result: ExtractionResult;
  notes?: string;
}

export interface BenchmarkRunRow {
  id: number;
  document_name: string;
  document_hash: string;
  document_pages: number;
  model: string;
  provider: string;
  reasoning_enabled: number;
  reasoning_effort: string | null;
  extraction_time_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  fields_found: number;
  fields_missing: number;
  fields_total: number;
  field_rate: number;
  einzelforderungen_count: number;
  aktiva_count: number;
  anfechtung_count: number;
  letters_ready: number;
  gesamtforderungen: number | null;
  summe_aktiva: number | null;
  gesamtpotenzial: number | null;
  notes: string | null;
  created_at: string;
}

/**
 * Save a benchmark run. Replaces existing run for same document+model+provider+reasoning combo.
 */
export function saveBenchmarkRun(input: BenchmarkRunInput): number {
  const d = getDb();
  const stats = computeExtractionStats(input.result);
  const fieldRate = stats.total > 0 ? stats.found / stats.total : 0;

  // Delete existing run for same combo (UPSERT)
  d.prepare(`
    DELETE FROM benchmark_runs
    WHERE document_hash = ? AND model = ? AND provider = ? AND reasoning_enabled = ?
  `).run(input.documentHash, input.model, input.provider, input.reasoningEnabled ? 1 : 0);

  const insertRun = d.prepare(`
    INSERT INTO benchmark_runs (
      document_name, document_hash, document_pages,
      model, provider, reasoning_enabled, reasoning_effort,
      extraction_time_ms, input_tokens, output_tokens,
      fields_found, fields_missing, fields_total, field_rate,
      einzelforderungen_count, aktiva_count, anfechtung_count, letters_ready,
      gesamtforderungen, summe_aktiva, gesamtpotenzial,
      result_json, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = input.result;
  const info = insertRun.run(
    input.documentName,
    input.documentHash,
    input.documentPages,
    input.model,
    input.provider,
    input.reasoningEnabled ? 1 : 0,
    input.reasoningEffort ?? null,
    input.extractionTimeMs,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    stats.found,
    stats.missing,
    stats.total,
    fieldRate,
    result.forderungen?.einzelforderungen?.length ?? 0,
    result.aktiva?.positionen?.length ?? 0,
    result.anfechtung?.vorgaenge?.length ?? 0,
    stats.lettersReady,
    typeof result.forderungen?.gesamtforderungen?.wert === 'number' ? result.forderungen.gesamtforderungen.wert : null,
    typeof result.aktiva?.summe_aktiva?.wert === 'number' ? result.aktiva.summe_aktiva.wert : null,
    typeof result.anfechtung?.gesamtpotenzial?.wert === 'number' ? result.anfechtung.gesamtpotenzial.wert : null,
    JSON.stringify(result),
    input.notes ?? null,
  );

  const runId = Number(info.lastInsertRowid);

  // Save per-field details
  const insertField = d.prepare(`
    INSERT INTO benchmark_fields (run_id, field_path, field_label, value, filled, quelle)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertFields = d.transaction((fields: typeof stats.fields) => {
    for (const f of fields) {
      const quelle = getQuelle(result, f.path);
      insertField.run(runId, f.path, f.label, f.value, f.filled ? 1 : 0, quelle);
    }
  });

  insertFields(stats.fields);

  return runId;
}

/** Get the quelle (source) for a field path from the result */
function getQuelle(result: ExtractionResult, fieldPath: string): string | null {
  const parts = fieldPath.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj && typeof obj === 'object' && 'quelle' in obj) {
    return String((obj as { quelle: unknown }).quelle || '');
  }
  return null;
}

/** List all benchmark runs, optionally filtered */
export function listBenchmarkRuns(documentHash?: string): BenchmarkRunRow[] {
  const d = getDb();
  if (documentHash) {
    return d.prepare(`
      SELECT * FROM benchmark_runs WHERE document_hash = ? ORDER BY created_at DESC
    `).all(documentHash) as BenchmarkRunRow[];
  }
  return d.prepare(`SELECT * FROM benchmark_runs ORDER BY document_name, created_at DESC`).all() as BenchmarkRunRow[];
}

/** Get field-level details for a benchmark run */
export function getBenchmarkFields(runId: number): Array<{
  field_path: string;
  field_label: string;
  value: string | null;
  filled: number;
  quelle: string | null;
}> {
  const d = getDb();
  return d.prepare(`SELECT field_path, field_label, value, filled, quelle FROM benchmark_fields WHERE run_id = ? ORDER BY field_path`).all(runId) as any[];
}

/** Compare two benchmark runs field-by-field */
export function compareBenchmarkRuns(runIdA: number, runIdB: number): Array<{
  field_path: string;
  label: string;
  value_a: string | null;
  value_b: string | null;
  filled_a: boolean;
  filled_b: boolean;
  match: boolean;
}> {
  const fieldsA = getBenchmarkFields(runIdA);
  const fieldsB = getBenchmarkFields(runIdB);

  const mapA = new Map(fieldsA.map(f => [f.field_path, f]));
  const mapB = new Map(fieldsB.map(f => [f.field_path, f]));

  const allPaths = new Set([...mapA.keys(), ...mapB.keys()]);
  const comparison: Array<{
    field_path: string; label: string;
    value_a: string | null; value_b: string | null;
    filled_a: boolean; filled_b: boolean; match: boolean;
  }> = [];

  for (const p of [...allPaths].sort()) {
    const a = mapA.get(p);
    const b = mapB.get(p);
    comparison.push({
      field_path: p,
      label: a?.field_label ?? b?.field_label ?? p,
      value_a: a?.value ?? null,
      value_b: b?.value ?? null,
      filled_a: a?.filled === 1,
      filled_b: b?.filled === 1,
      match: a?.value === b?.value,
    });
  }

  return comparison;
}

/** Compute document hash from PDF buffer */
export function computeDocumentHash(pdfBuffer: Buffer): string {
  return createHash('sha256').update(pdfBuffer).digest('hex').substring(0, 16);
}
