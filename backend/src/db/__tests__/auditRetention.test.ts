import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../utils/__tests__/testDb';
import { cleanupOldAuditLog } from '../database';
import { getDb } from '../database';

describe('cleanupOldAuditLog', () => {
  beforeEach(() => setupTestDb());

  function insertAudit(daysAgo: number, action = 'share_read'): void {
    getDb().prepare(
      `INSERT INTO audit_log (user_id, action, details, created_at)
       VALUES (?, ?, ?, datetime('now', '-' || ? || ' days'))`
    ).run(1, action, JSON.stringify({ extractionId: 1 }), String(daysAgo));
  }

  it('deletes rows older than retention', () => {
    insertAudit(2000);
    insertAudit(1900);
    insertAudit(100);
    expect(cleanupOldAuditLog(1825)).toBe(2);
    const remaining = getDb().prepare('SELECT count(*) as c FROM audit_log').get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  it('is a no-op when retentionDays is 0 (disabled)', () => {
    insertAudit(5000);
    expect(cleanupOldAuditLog(0)).toBe(0);
    const remaining = getDb().prepare('SELECT count(*) as c FROM audit_log').get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  it('uses default retention (1825 days) when called without arg', () => {
    insertAudit(2000);
    insertAudit(100);
    expect(cleanupOldAuditLog()).toBe(1);
  });
});

describe('audit_log share-extraction index', () => {
  beforeEach(() => setupTestDb());

  it('partial expression index exists after migration 009', () => {
    const idx = getDb().prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_audit_share_extraction'"
    ).get() as { name: string; sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toContain("json_extract(details, '$.extractionId')");
    expect(idx!.sql).toContain("WHERE action IN");
  });

  it('SQLite query plan uses the index for the access-log lookup', () => {
    // Seed one share_read so json_extract returns a non-null value
    getDb().prepare(
      "INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)"
    ).run(1, 'share_read', JSON.stringify({ extractionId: 42 }));

    const plan = getDb().prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM audit_log
       WHERE action IN ('share_read','share_edit','share_granted','share_revoked')
         AND json_extract(details, '$.extractionId') = ?`
    ).all(42) as Array<{ detail: string }>;

    const planText = plan.map(r => r.detail).join(' | ');
    expect(planText.toLowerCase()).toContain('idx_audit_share_extraction');
  });
});
