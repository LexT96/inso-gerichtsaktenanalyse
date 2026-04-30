import { initDatabase, getDb } from '../../db/database';

/**
 * Initializes a fresh in-memory SQLite DB with all migrations applied
 * + seeds four users (alice = id 1, bob = id 2, charlie = id 3, admin = id 4).
 * Re-running this overrides the module-level `db` with a new in-memory instance.
 * Returns the seeded DB.
 */
export function setupTestDb() {
  initDatabase(':memory:');
  const db = getDb();

  const ins = db.prepare(
    'INSERT INTO users (id, username, password_hash, display_name, role, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  ins.run(1, 'alice',   'x', 'Alice Owner',        'user');
  ins.run(2, 'bob',     'x', 'Bob Collaborator',   'user');
  ins.run(3, 'charlie', 'x', 'Charlie Outsider',   'user');
  ins.run(4, 'admin',   'x', 'Administrator',      'admin');

  return db;
}

/**
 * Inserts a minimal extraction owned by `ownerId`. Returns the new extraction id.
 */
export function seedExtraction(ownerId: number, filename = 'akte.pdf'): number {
  const result = getDb().prepare(
    `INSERT INTO extractions (user_id, filename, file_size, status)
     VALUES (?, ?, 1024, 'completed')`
  ).run(ownerId, filename);
  return result.lastInsertRowid as number;
}
