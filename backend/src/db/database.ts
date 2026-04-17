import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { encryptDbField } from '../utils/crypto';

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
