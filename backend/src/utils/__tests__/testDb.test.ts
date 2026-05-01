import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, seedExtraction } from './testDb';
import { getDb } from '../../db/database';

describe('testDb helper', () => {
  beforeEach(() => setupTestDb());

  it('creates DB with all migrations and seeded users', () => {
    const tableCount = getDb().prepare(
      "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name IN ('users','extractions','extraction_shares','audit_log')"
    ).get() as { c: number };
    expect(tableCount.c).toBe(4);

    const users = getDb().prepare('SELECT id, username, role FROM users ORDER BY id').all();
    expect(users).toEqual([
      { id: 1, username: 'alice',   role: 'user' },
      { id: 2, username: 'bob',     role: 'user' },
      { id: 3, username: 'charlie', role: 'user' },
      { id: 4, username: 'admin',   role: 'admin' },
    ]);
  });

  it('seedExtraction inserts a row owned by the given user', () => {
    const id = seedExtraction(1, 'test.pdf');
    const row = getDb().prepare('SELECT user_id, filename FROM extractions WHERE id = ?').get(id);
    expect(row).toEqual({ user_id: 1, filename: 'test.pdf' });
  });
});
