import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { encryptDbField } from '../utils/crypto';
import { config } from '../config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Datenbank nicht initialisiert. Rufe initDatabase() auf.');
  }
  return db;
}

export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  backfillDocuments(db);
  logger.info('Datenbank initialisiert', { path: dbPath });
  return db;
}

function runMigrations(database: Database.Database): void {
  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn('Migrations-Verzeichnis nicht gefunden', { path: migrationsDir });
    return;
  }

  // Track which migrations have already run
  database.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Seed: if _migrations is empty but tables already exist, mark 001 as applied
  const migrationCount = (database.prepare('SELECT count(*) as c FROM _migrations').get() as { c: number }).c;
  if (migrationCount === 0) {
    const tableExists = database.prepare(
      "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='extractions'"
    ).get() as { c: number };
    if (tableExists.c > 0) {
      database.prepare("INSERT INTO _migrations (name) VALUES ('001_initial.sql')").run();
    }
  }

  const applied = new Set(
    (database.prepare('SELECT name FROM _migrations').all() as { name: string }[])
      .map(r => r.name)
  );

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    database.exec(sql);
    database.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    logger.info(`Migration ausgeführt: ${file}`);
  }
}

/**
 * Backfill: create document records for existing extractions that have no documents entry.
 * Also migrates PDFs from flat structure (data/pdfs/{id}.pdf) to per-extraction directories
 * (data/pdfs/{id}/0_gerichtsakte.pdf).
 */
function backfillDocuments(database: Database.Database): void {
  // Check if documents table exists (migration may not have run yet on first boot)
  const tableExists = database.prepare(
    "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='documents'"
  ).get() as { c: number };
  if (tableExists.c === 0) return;

  const existingWithoutDocs = database.prepare(`
    SELECT e.id, e.filename FROM extractions e
    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.extraction_id = e.id)
    AND e.status = 'completed'
  `).all() as Array<{ id: number; filename: string }>;

  if (existingWithoutDocs.length === 0) return;

  const insert = database.prepare(`
    INSERT INTO documents (extraction_id, doc_index, source_type, original_filename, page_count)
    VALUES (?, 0, 'gerichtsakte', ?, 0)
  `);
  for (const row of existingWithoutDocs) {
    insert.run(row.id, row.filename);
  }
  logger.info('Dokumente-Backfill abgeschlossen', { count: existingWithoutDocs.length });

  // Migrate PDF files: data/pdfs/{id}.pdf -> data/pdfs/{id}/0_gerichtsakte.pdf
  const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
  for (const row of existingWithoutDocs) {
    const oldPath = path.join(pdfDir, `${row.id}.pdf`);
    const newDir = path.join(pdfDir, String(row.id));
    const newPath = path.join(newDir, '0_gerichtsakte.pdf');
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(oldPath, newPath);
    }
  }
}

export function cleanupExpiredExtractions(retentionHours?: number): void {
  if (!db) return;
  const hours = retentionHours ?? 72;
  if (hours <= 0) return; // 0 = disabled, no auto-deletion
  try {
    const result = db.prepare(
      `UPDATE extractions
       SET result_json = NULL, status = 'expired'
       WHERE result_json IS NOT NULL
         AND status = 'completed'
         AND filename != 'demo-test.pdf'
         AND created_at < datetime('now', '-' || ? || ' hours')`
    ).run(String(hours));
    if (result.changes > 0) {
      logger.info('Abgelaufene Extraktionen bereinigt', { count: result.changes, retentionHours: hours });
    }
  } catch (err) {
    logger.error('Fehler bei der Bereinigung abgelaufener Extraktionen', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * One-time migration: encrypt any existing unencrypted result_json rows.
 * Detects legacy rows by checking if value starts with '{' (plain JSON) rather than '$ENC$'.
 */
export function encryptExistingResults(encryptionKey: string): void {
  if (!db) return;
  try {
    const rows = db.prepare(
      "SELECT id, result_json FROM extractions WHERE result_json IS NOT NULL AND result_json NOT LIKE '$ENC$%'"
    ).all() as Array<{ id: number; result_json: string }>;

    if (rows.length === 0) return;

    const update = db.prepare('UPDATE extractions SET result_json = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const row of rows) {
        const encrypted = encryptDbField(row.result_json, encryptionKey);
        update.run(encrypted, row.id);
      }
    });
    tx();

    logger.info('Bestehende Extraktionen verschlüsselt', { count: rows.length });
  } catch (err) {
    logger.error('Fehler bei der Verschlüsselung bestehender Extraktionen', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    logger.info('Datenbank geschlossen');
  }
}
