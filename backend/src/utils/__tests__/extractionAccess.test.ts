import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/database';
import { setupTestDb, seedExtraction } from './testDb';
import { getExtractionAccess, accessibleExtractionIds } from '../extractionAccess';

describe('getExtractionAccess', () => {
  beforeEach(() => setupTestDb());

  it('returns null for non-existent extraction', () => {
    expect(getExtractionAccess(999, 1, 'user')).toBeNull();
  });

  it('returns owner role when user owns the extraction', () => {
    const id = seedExtraction(1);
    expect(getExtractionAccess(id, 1, 'user')).toEqual({ extractionId: id, role: 'owner', ownerId: 1 });
  });

  it('returns collaborator role when user has a share', () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    expect(getExtractionAccess(id, 2, 'user')).toEqual({ extractionId: id, role: 'collaborator', ownerId: 1 });
  });

  it('returns null when user is neither owner nor share', () => {
    const id = seedExtraction(1);
    expect(getExtractionAccess(id, 3, 'user')).toBeNull();
  });

  it('returns admin role for admin even without share', () => {
    const id = seedExtraction(1);
    expect(getExtractionAccess(id, 4, 'admin')).toEqual({ extractionId: id, role: 'admin', ownerId: 1 });
  });

  it('admin who is also owner gets admin role (precedence)', () => {
    const id = seedExtraction(4);
    expect(getExtractionAccess(id, 4, 'admin')).toEqual({ extractionId: id, role: 'admin', ownerId: 4 });
  });
});

describe('accessibleExtractionIds', () => {
  beforeEach(() => setupTestDb());

  it('returns owned + shared ids for regular users', () => {
    const a = seedExtraction(1, 'a.pdf');
    const b = seedExtraction(1, 'b.pdf');
    const c = seedExtraction(2, 'c.pdf');
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(c, 1, 2);

    const ids = accessibleExtractionIds(1, 'user');
    expect(ids.ownedIds.sort()).toEqual([a, b].sort());
    expect(ids.sharedIds).toEqual([c]);
  });

  it('returns empty arrays for admin (caller branches on role)', () => {
    seedExtraction(1);
    expect(accessibleExtractionIds(4, 'admin')).toEqual({ ownedIds: [], sharedIds: [] });
  });
});
