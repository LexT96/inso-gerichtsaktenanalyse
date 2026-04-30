import { getDb } from '../db/database';

export type AccessRole = 'owner' | 'collaborator' | 'admin';

export interface ExtractionAccess {
  extractionId: number;
  role: AccessRole;
  ownerId: number;
}

export function getExtractionAccess(
  extractionId: number,
  userId: number,
  userRole: 'admin' | 'user'
): ExtractionAccess | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT user_id FROM extractions WHERE id = ?'
  ).get(extractionId) as { user_id: number } | undefined;
  if (!row) return null;

  if (userRole === 'admin')   return { extractionId, role: 'admin',        ownerId: row.user_id };
  if (row.user_id === userId) return { extractionId, role: 'owner',        ownerId: row.user_id };

  const share = db.prepare(
    'SELECT 1 FROM extraction_shares WHERE extraction_id = ? AND user_id = ?'
  ).get(extractionId, userId);
  if (share)                  return { extractionId, role: 'collaborator', ownerId: row.user_id };

  return null;
}

export function accessibleExtractionIds(
  userId: number,
  userRole: 'admin' | 'user'
): { ownedIds: number[]; sharedIds: number[] } {
  if (userRole === 'admin') return { ownedIds: [], sharedIds: [] };

  const db = getDb();
  const owned = db.prepare('SELECT id FROM extractions WHERE user_id = ?').all(userId) as { id: number }[];
  const shared = db.prepare(
    'SELECT extraction_id AS id FROM extraction_shares WHERE user_id = ?'
  ).all(userId) as { id: number }[];
  return { ownedIds: owned.map(r => r.id), sharedIds: shared.map(r => r.id) };
}
