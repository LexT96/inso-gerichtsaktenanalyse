# Akten-Teilen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sachbearbeiter (Owner) kann Akten mit anderen aktiven Usern teilen — Mitbearbeiter dürfen voll editieren, Owner-only sind Delete/Export/Re-Share. Jeder Collaborator-Zugriff wird auditiert.

**Architecture:** Dedicated `extraction_shares` table; `extractions.user_id` bleibt der Owner. Neue Middleware `requireExtractionAccess` zentralisiert Zugriffsprüfung (404 bei kein-Zugriff, 403 nur bei `OWNER_ONLY`) und auto-loggt Collaborator/Admin-Zugriffe. Späteres Team-Modell pluggt via paralleler `team_extraction_shares` Tabelle ein, ohne dieses Schema zu refactoren.

**Tech Stack:** Express 4 + better-sqlite3 (Backend), React 18 + axios + Tailwind (Frontend), vitest (Tests). TypeScript überall.

**Spec:** `docs/superpowers/specs/2026-04-30-akten-teilen-design.md`

---

## File Structure

**Backend (neu):**
- `backend/src/db/migrations/008_add_extraction_shares.sql` — Schema-Migration
- `backend/src/utils/extractionAccess.ts` — Helper: `getExtractionAccess`, `accessibleExtractionIds`
- `backend/src/middleware/extractionAccess.ts` — `requireExtractionAccess({ ownerOnly?, skipAudit? })`
- `backend/src/routes/shares.ts` — GET/POST/DELETE Share-CRUD + access-log
- `backend/src/routes/users.ts` — GET /share-candidates
- `backend/src/utils/__tests__/extractionAccess.test.ts`
- `backend/src/utils/__tests__/testDb.ts` (helper)
- `backend/src/middleware/__tests__/extractionAccess.test.ts`
- `backend/src/routes/__tests__/shares.test.ts`
- `backend/src/routes/__tests__/users.test.ts`
- `backend/src/routes/__tests__/history.access.test.ts`

**Backend (modifiziert):**
- `backend/src/index.ts` — mount /api/extractions/:id/shares, /api/users
- `backend/src/routes/history.ts` — UNION-Listing + middleware
- `backend/src/routes/fieldUpdate.ts` — middleware
- `backend/src/routes/generateLetter.ts` — middleware
- `backend/src/routes/generateGutachten.ts` — middleware
- `backend/src/routes/documents.ts` — middleware

**Frontend (neu):**
- `frontend/src/api/shares.ts` — axios-Wrapper für Share-Endpoints
- `frontend/src/components/share/ShareModal.tsx`
- `frontend/src/components/share/CollaboratorBanner.tsx`
- `frontend/src/components/share/AccessLogTab.tsx`

**Frontend (modifiziert):**
- `frontend/src/components/dashboard/HistoryPanel.tsx` (oder `pages/HistoryPage.tsx`) — Pill + accessRole
- Akte-Detail-Komponente (Owner-Check für Share-Button + Banner-Render für Collaborator)

**Shared (modifiziert):**
- `shared/types/api.ts` — neue Typen `AccessRole`, `ExtractionShare`, `HistoryItem.accessRole/ownerName`, `ExtractionResponse.accessRole/ownerName`
- `backend/src/types/api.ts` — gleiche Typen mirrored

---

## Test-Konventionen (vorab lesen)

- vitest, Test-Dateien unter `backend/src/<area>/__tests__/<name>.test.ts`
- Test-DB: in-memory SQLite via existierendem `initDatabase(':memory:')` — ruft alle Migrations + setzt das module-lokale `db` auf die memory-DB. Helper in `testDb.ts` seedet User danach.
- Auth-Tests: stellen `req.user` direkt im Handler-Test bereit. Routen-Tests via `supertest` gegen frische Express-App-Instanz.

Run a single test: `cd backend && npm test -- src/utils/__tests__/extractionAccess.test.ts`
Run all tests: `cd backend && npm test`

Required env vars für Tests (vom CI bereits gesetzt):
```
JWT_SECRET=dummydummydummydummydummydummydummy
DB_ENCRYPTION_KEY=dummydummydummydummydummydummydummy
DEFAULT_ADMIN_PASSWORD=dummydummy
ANTHROPIC_API_KEY=sk-ant-dummy
```

---

## Task 1: DB-Migration für `extraction_shares`

**Files:**
- Create: `backend/src/db/migrations/008_add_extraction_shares.sql`

- [ ] **Step 1: Schreibe Migration**

```sql
-- backend/src/db/migrations/008_add_extraction_shares.sql
CREATE TABLE IF NOT EXISTS extraction_shares (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id INTEGER NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  granted_by    INTEGER NOT NULL REFERENCES users(id),
  granted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(extraction_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_shares_user
  ON extraction_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_extraction_shares_extraction
  ON extraction_shares(extraction_id);
```

- [ ] **Step 2: Verifiziere durch Backend-Test-Lauf**

```bash
cd backend && npm test
```

Expected: alle 126 Tests grün. Die Migration läuft beim DB-Init der Tests automatisch (siehe `database.ts:33` `runMigrations`).

- [ ] **Step 3: Commit**

```bash
cd /Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/.worktrees/akten-teilen
git add backend/src/db/migrations/008_add_extraction_shares.sql
git commit -m "feat(db): add extraction_shares table for akte sharing"
```

---

## Task 2: Test-DB Helper

**Files:**
- Create: `backend/src/utils/__tests__/testDb.ts`

(Wird von Tasks 3, 4, 5, 6, 7, 8 wiederverwendet — DRY.)

- [ ] **Step 1: Helper schreiben**

```ts
// backend/src/utils/__tests__/testDb.ts
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
```

- [ ] **Step 2: Smoke-Test, dass Helper funktioniert**

```ts
// backend/src/utils/__tests__/testDb.test.ts
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
```

- [ ] **Step 3: Tests laufen lassen**

```bash
cd backend && npm test -- src/utils/__tests__/testDb.test.ts
```

Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add backend/src/utils/__tests__/testDb.ts backend/src/utils/__tests__/testDb.test.ts
git commit -m "test: add in-memory test-db helper with seeded users"
```

---

## Task 3: Auth-Helper `extractionAccess.ts` (TDD)

**Files:**
- Create: `backend/src/utils/__tests__/extractionAccess.test.ts`
- Create: `backend/src/utils/extractionAccess.ts`

- [ ] **Step 1: Schreibe Tests zuerst**

```ts
// backend/src/utils/__tests__/extractionAccess.test.ts
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
```

- [ ] **Step 2: Tests laufen — sollten fehlschlagen**

```bash
cd backend && npm test -- src/utils/__tests__/extractionAccess.test.ts
```

Expected: FAIL with "Cannot find module '../extractionAccess'".

- [ ] **Step 3: Implementation schreiben**

```ts
// backend/src/utils/extractionAccess.ts
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
```

- [ ] **Step 4: Tests laufen — sollten passen**

```bash
cd backend && npm test -- src/utils/__tests__/extractionAccess.test.ts
```

Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/extractionAccess.ts backend/src/utils/__tests__/extractionAccess.test.ts
git commit -m "feat(auth): add getExtractionAccess + accessibleExtractionIds helpers"
```

---

## Task 4: Middleware `requireExtractionAccess` (TDD, ohne Audit)

**Files:**
- Create: `backend/src/middleware/__tests__/extractionAccess.test.ts`
- Create: `backend/src/middleware/extractionAccess.ts`

- [ ] **Step 1: Schreibe Tests zuerst**

```ts
// backend/src/middleware/__tests__/extractionAccess.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { getDb } from '../../db/database';
import { setupTestDb, seedExtraction } from '../../utils/__tests__/testDb';
import { requireExtractionAccess } from '../extractionAccess';

function makeReq(opts: { id?: string; userId: number; role: 'admin'|'user'; method?: string; path?: string }): Request {
  return {
    params: { id: opts.id ?? '' },
    user: { userId: opts.userId, username: 'u', role: opts.role },
    method: opts.method ?? 'GET',
    path: opts.path ?? '/',
    ip: '127.0.0.1',
  } as unknown as Request;
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    _status: undefined,
    _body: undefined,
    _finishCb: undefined,
    status(c: number) { this._status = c; this.statusCode = c; return this; },
    json(b: unknown)  { this._body = b; return this; },
    on(ev: string, cb: () => void) { if (ev === 'finish') this._finishCb = cb; return this; },
  };
  return res as Response & { _status?: number; _body?: any; _finishCb?: () => void };
}

describe('requireExtractionAccess', () => {
  beforeEach(() => setupTestDb());

  it('returns 400 on invalid id', () => {
    const req = makeReq({ id: 'abc', userId: 1, role: 'user' });
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess()(req, res, next);
    expect(res._status).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 on non-existent extraction', () => {
    const req = makeReq({ id: '999', userId: 1, role: 'user' });
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess()(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 404 (not 403) when user has no access — info-leak protection', () => {
    const id = seedExtraction(1);
    const req = makeReq({ id: String(id), userId: 3, role: 'user' });
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess()(req, res, next);
    expect(res._status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches access to req and calls next for owner', () => {
    const id = seedExtraction(1);
    const req = makeReq({ id: String(id), userId: 1, role: 'user' });
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).access).toEqual({ extractionId: id, role: 'owner', ownerId: 1 });
  });

  it('returns 403 OWNER_ONLY for collaborator on owner-only route', () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const req = makeReq({ id: String(id), userId: 2, role: 'user' });
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess({ ownerOnly: true })(req, res, next);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ code: 'OWNER_ONLY' });
    expect(next).not.toHaveBeenCalled();
  });

  it('admin passes ownerOnly check', () => {
    const id = seedExtraction(1);
    const req = makeReq({ id: String(id), userId: 4, role: 'admin' });
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess({ ownerOnly: true })(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('also reads extractionId param when id param missing', () => {
    const id = seedExtraction(1);
    const req = { ...makeReq({ userId: 1, role: 'user' }), params: { extractionId: String(id) } } as unknown as Request;
    const res = makeRes();
    const next = vi.fn();
    requireExtractionAccess()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).access).toMatchObject({ extractionId: id });
  });
});
```

- [ ] **Step 2: Tests laufen — sollten fehlen**

```bash
cd backend && npm test -- src/middleware/__tests__/extractionAccess.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Middleware implementieren (ohne Audit, der kommt in Task 5)**

```ts
// backend/src/middleware/extractionAccess.ts
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getExtractionAccess, type ExtractionAccess } from '../utils/extractionAccess';

declare global {
  namespace Express {
    interface Request {
      access?: ExtractionAccess;
    }
  }
}

function parseIdParam(req: Request): number {
  const raw = req.params['id'] ?? req.params['extractionId'] ?? '';
  const v = Array.isArray(raw) ? raw[0] : raw;
  return parseInt(String(v), 10);
}

export interface RequireAccessOpts {
  ownerOnly?: boolean;
  /** Skip auto-audit (used by share-routes which write their own action names). */
  skipAudit?: boolean;
}

export function requireExtractionAccess(opts: RequireAccessOpts = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = parseIdParam(req);
    if (isNaN(id)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

    const access = getExtractionAccess(id, req.user!.userId, req.user!.role as 'admin'|'user');
    if (!access) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    if (opts.ownerOnly && access.role !== 'owner' && access.role !== 'admin') {
      res.status(403).json({
        error: 'Diese Aktion ist dem Eigentümer der Akte vorbehalten',
        code: 'OWNER_ONLY',
      });
      return;
    }

    req.access = access;
    next();
  };
}
```

- [ ] **Step 4: Tests laufen — sollten passen**

```bash
cd backend && npm test -- src/middleware/__tests__/extractionAccess.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/extractionAccess.ts backend/src/middleware/__tests__/extractionAccess.test.ts
git commit -m "feat(auth): add requireExtractionAccess middleware (404 vs 403 + ownerOnly)"
```

---

## Task 5: Audit-Hook in der Middleware (TDD)

**Files:**
- Modify: `backend/src/middleware/extractionAccess.ts`
- Modify: `backend/src/middleware/__tests__/extractionAccess.test.ts`

- [ ] **Step 1: Test-Datei erweitern (append unten anhängen)**

```ts
// hänge an backend/src/middleware/__tests__/extractionAccess.test.ts an:

describe('requireExtractionAccess audit-hook', () => {
  beforeEach(() => setupTestDb());

  function runFinish(res: ReturnType<typeof makeRes>) {
    if (res._finishCb) res._finishCb();
  }

  it('does NOT audit owner reads', () => {
    const id = seedExtraction(1);
    const req = makeReq({ id: String(id), userId: 1, role: 'user', method: 'GET' });
    const res = makeRes();
    requireExtractionAccess()(req, res, vi.fn());
    res.statusCode = 200;
    runFinish(res);

    const log = getDb().prepare("SELECT count(*) as c FROM audit_log WHERE action LIKE 'share_%'").get() as { c: number };
    expect(log.c).toBe(0);
  });

  it('audits collaborator GET as share_read', () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const req = makeReq({ id: String(id), userId: 2, role: 'user', method: 'GET', path: `/${id}` });
    const res = makeRes();
    requireExtractionAccess()(req, res, vi.fn());
    res.statusCode = 200;
    runFinish(res);

    const row = getDb().prepare("SELECT user_id, action, details FROM audit_log WHERE action='share_read'").get() as
      { user_id: number; action: string; details: string };
    expect(row.user_id).toBe(2);
    expect(JSON.parse(row.details)).toMatchObject({ extractionId: id, method: 'GET', role: 'collaborator' });
  });

  it('audits collaborator POST as share_edit', () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const req = makeReq({ id: String(id), userId: 2, role: 'user', method: 'POST' });
    const res = makeRes();
    requireExtractionAccess()(req, res, vi.fn());
    res.statusCode = 200;
    runFinish(res);

    const row = getDb().prepare("SELECT action FROM audit_log WHERE user_id = 2").get() as { action: string };
    expect(row.action).toBe('share_edit');
  });

  it('audits admin reads with role:admin', () => {
    const id = seedExtraction(1);
    const req = makeReq({ id: String(id), userId: 4, role: 'admin', method: 'GET' });
    const res = makeRes();
    requireExtractionAccess()(req, res, vi.fn());
    res.statusCode = 200;
    runFinish(res);

    const row = getDb().prepare("SELECT action, details FROM audit_log WHERE user_id = 4").get() as { action: string; details: string };
    expect(row.action).toBe('share_read');
    expect(JSON.parse(row.details)).toMatchObject({ role: 'admin' });
  });

  it('does NOT audit when statusCode >= 400', () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const req = makeReq({ id: String(id), userId: 2, role: 'user', method: 'GET' });
    const res = makeRes();
    requireExtractionAccess()(req, res, vi.fn());
    res.statusCode = 500;
    runFinish(res);

    const log = getDb().prepare("SELECT count(*) as c FROM audit_log WHERE action LIKE 'share_%'").get() as { c: number };
    expect(log.c).toBe(0);
  });

  it('skips audit when skipAudit:true (used by share-routes themselves)', () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const req = makeReq({ id: String(id), userId: 2, role: 'user', method: 'POST' });
    const res = makeRes();
    requireExtractionAccess({ skipAudit: true })(req, res, vi.fn());
    res.statusCode = 200;
    runFinish(res);

    const log = getDb().prepare("SELECT count(*) as c FROM audit_log WHERE action LIKE 'share_%'").get() as { c: number };
    expect(log.c).toBe(0);
  });
});
```

- [ ] **Step 2: Tests laufen — sollten fehlschlagen (kein Audit-Code)**

```bash
cd backend && npm test -- src/middleware/__tests__/extractionAccess.test.ts
```

Expected: 5 of 6 new tests FAIL (audit_log has no rows).

- [ ] **Step 3: Audit-Hook in Middleware einbauen — kompletter ersetzter Body**

Replace the `requireExtractionAccess` function in `backend/src/middleware/extractionAccess.ts` entirely:

```ts
// backend/src/middleware/extractionAccess.ts (final version with audit)
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getExtractionAccess, type ExtractionAccess } from '../utils/extractionAccess';
import { getDb } from '../db/database';

declare global {
  namespace Express {
    interface Request {
      access?: ExtractionAccess;
    }
  }
}

function parseIdParam(req: Request): number {
  const raw = req.params['id'] ?? req.params['extractionId'] ?? '';
  const v = Array.isArray(raw) ? raw[0] : raw;
  return parseInt(String(v), 10);
}

export interface RequireAccessOpts {
  ownerOnly?: boolean;
  /** Skip auto-audit (used by share-routes which write their own action names). */
  skipAudit?: boolean;
}

export function requireExtractionAccess(opts: RequireAccessOpts = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = parseIdParam(req);
    if (isNaN(id)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

    const access = getExtractionAccess(id, req.user!.userId, req.user!.role as 'admin'|'user');
    if (!access) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    if (opts.ownerOnly && access.role !== 'owner' && access.role !== 'admin') {
      res.status(403).json({
        error: 'Diese Aktion ist dem Eigentümer der Akte vorbehalten',
        code: 'OWNER_ONLY',
      });
      return;
    }

    req.access = access;

    if (!opts.skipAudit && access.role !== 'owner') {
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
        const action = isWrite ? 'share_edit' : 'share_read';
        const details = JSON.stringify({
          extractionId: id,
          method: req.method,
          path: req.path,
          role: access.role,
        });
        try {
          getDb().prepare(
            'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
          ).run(req.user!.userId, action, details, req.ip ?? null);
        } catch (err) {
          // Audit failure must not break the response. Log via console (logger import would risk circular deps).
          // eslint-disable-next-line no-console
          console.error('audit insert failed', err);
        }
      });
    }

    next();
  };
}
```

- [ ] **Step 4: Tests laufen — alle grün**

```bash
cd backend && npm test -- src/middleware/__tests__/extractionAccess.test.ts
```

Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/extractionAccess.ts backend/src/middleware/__tests__/extractionAccess.test.ts
git commit -m "feat(audit): auto-log collaborator+admin reads/edits via middleware finish-hook"
```

---

## Task 6: Routes `shares.ts` (TDD via supertest)

**Files:**
- Create: `backend/src/routes/__tests__/shares.test.ts`
- Create: `backend/src/routes/shares.ts`

- [ ] **Step 1: Check ob `supertest` installiert ist; falls nicht, installieren**

```bash
cd backend && grep '"supertest"' package.json || npm install -D supertest @types/supertest
```

- [ ] **Step 2: Tests schreiben**

```ts
// backend/src/routes/__tests__/shares.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { getDb } from '../../db/database';
import { setupTestDb, seedExtraction } from '../../utils/__tests__/testDb';
import sharesRouter from '../shares';
import { config } from '../../config';

function tokenFor(userId: number, role: 'user'|'admin'): string {
  return jwt.sign({ userId, username: `u${userId}`, role }, config.JWT_SECRET);
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/extractions', sharesRouter);
  return app;
}

describe('POST /api/extractions/:id/shares', () => {
  beforeEach(() => setupTestDb());

  it('grants share when called by owner', async () => {
    const id = seedExtraction(1);
    const res = await request(makeApp())
      .post(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`])
      .send({ userId: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: 2, displayName: 'Bob Collaborator' });

    const row = getDb().prepare('SELECT * FROM extraction_shares WHERE extraction_id = ? AND user_id = ?').get(id, 2);
    expect(row).toBeDefined();
  });

  it('returns 400 when user tries to share with self', async () => {
    const id = seedExtraction(1);
    const res = await request(makeApp())
      .post(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`])
      .send({ userId: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate share', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const res = await request(makeApp())
      .post(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`])
      .send({ userId: 2 });
    expect(res.status).toBe(409);
  });

  it('returns 404 when recipient is inactive', async () => {
    const id = seedExtraction(1);
    getDb().prepare('UPDATE users SET active = 0 WHERE id = 2').run();
    const res = await request(makeApp())
      .post(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`])
      .send({ userId: 2 });
    expect(res.status).toBe(404);
  });

  it('returns 403 OWNER_ONLY when collaborator tries to grant', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const res = await request(makeApp())
      .post(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(2, 'user')}`])
      .send({ userId: 3 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'OWNER_ONLY' });
  });

  it('writes share_granted audit entry', async () => {
    const id = seedExtraction(1);
    await request(makeApp())
      .post(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`])
      .send({ userId: 2 });
    const row = getDb().prepare("SELECT action, details FROM audit_log WHERE action = 'share_granted'").get() as { action: string; details: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.details)).toMatchObject({ extractionId: id, recipientUserId: 2 });
  });
});

describe('GET /api/extractions/:id/shares', () => {
  beforeEach(() => setupTestDb());

  it('lists shares for owner', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const res = await request(makeApp())
      .get(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ userId: 2, displayName: 'Bob Collaborator', username: 'bob' });
  });

  it('returns 403 OWNER_ONLY for collaborator', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const res = await request(makeApp())
      .get(`/api/extractions/${id}/shares`)
      .set('Cookie', [`accessToken=${tokenFor(2, 'user')}`]);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/extractions/:id/shares/:userId', () => {
  beforeEach(() => setupTestDb());

  it('revokes share for owner', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const res = await request(makeApp())
      .delete(`/api/extractions/${id}/shares/2`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`]);
    expect(res.status).toBe(204);

    const after = getDb().prepare('SELECT 1 FROM extraction_shares WHERE extraction_id = ? AND user_id = ?').get(id, 2);
    expect(after).toBeUndefined();
  });

  it('returns 404 if share does not exist', async () => {
    const id = seedExtraction(1);
    const res = await request(makeApp())
      .delete(`/api/extractions/${id}/shares/2`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`]);
    expect(res.status).toBe(404);
  });

  it('writes share_revoked audit entry', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    await request(makeApp())
      .delete(`/api/extractions/${id}/shares/2`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`]);
    const row = getDb().prepare("SELECT action, details FROM audit_log WHERE action = 'share_revoked'").get() as { action: string; details: string };
    expect(row).toBeDefined();
    expect(JSON.parse(row.details)).toMatchObject({ extractionId: id, recipientUserId: 2 });
  });
});
```

- [ ] **Step 3: Tests laufen — sollten fehlschlagen**

```bash
cd backend && npm test -- src/routes/__tests__/shares.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Routen-Datei implementieren**

```ts
// backend/src/routes/shares.ts
import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireExtractionAccess } from '../middleware/extractionAccess';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const router = Router({ mergeParams: true });

// GET /:id/shares — list (owner+admin only)
router.get(
  '/:id/shares',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const rows = getDb().prepare(
      `SELECT s.user_id AS userId, u.display_name AS displayName, u.username AS username,
              s.granted_by AS grantedBy, s.granted_at AS grantedAt
       FROM extraction_shares s
       JOIN users u ON u.id = s.user_id
       WHERE s.extraction_id = ?
       ORDER BY s.granted_at DESC`
    ).all(extractionId);
    res.json(rows);
  }
);

// POST /:id/shares — grant (owner+admin only)
router.post(
  '/:id/shares',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  (req: Request, res: Response): void => {
    const { extractionId, ownerId } = req.access!;
    const body = req.body as { userId?: number };
    const recipientId = Number(body.userId);
    if (!Number.isFinite(recipientId)) { res.status(400).json({ error: 'userId fehlt' }); return; }

    if (recipientId === ownerId) {
      res.status(400).json({ error: 'Akte kann nicht mit dem Eigentümer geteilt werden' });
      return;
    }

    const recipient = getDb().prepare(
      'SELECT id, username, display_name, active FROM users WHERE id = ?'
    ).get(recipientId) as { id: number; username: string; display_name: string; active: number } | undefined;
    if (!recipient || recipient.active !== 1) {
      res.status(404).json({ error: 'Empfänger nicht gefunden oder deaktiviert' });
      return;
    }

    try {
      const result = getDb().prepare(
        'INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)'
      ).run(extractionId, recipientId, req.user!.userId);

      const row = getDb().prepare(
        'SELECT user_id AS userId, granted_at AS grantedAt FROM extraction_shares WHERE id = ?'
      ).get(result.lastInsertRowid) as { userId: number; grantedAt: string };

      getDb().prepare(
        'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
      ).run(
        req.user!.userId,
        'share_granted',
        JSON.stringify({ extractionId, recipientUserId: recipientId, recipientName: recipient.display_name }),
        req.ip ?? null
      );

      logger.info('Akte geteilt', { extractionId, recipientUserId: recipientId, grantedBy: req.user!.userId });
      res.status(201).json({ ...row, displayName: recipient.display_name, username: recipient.username });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: `${recipient.display_name} hat bereits Zugriff` });
        return;
      }
      throw err;
    }
  }
);

// DELETE /:id/shares/:userId — revoke (owner+admin only)
router.delete(
  '/:id/shares/:userId',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const recipientId = parseInt(String(req.params['userId']), 10);
    if (!Number.isFinite(recipientId)) { res.status(400).json({ error: 'Ungültige userId' }); return; }

    const existing = getDb().prepare(
      `SELECT s.user_id AS userId, u.display_name AS displayName
       FROM extraction_shares s JOIN users u ON u.id = s.user_id
       WHERE s.extraction_id = ? AND s.user_id = ?`
    ).get(extractionId, recipientId) as { userId: number; displayName: string } | undefined;
    if (!existing) { res.status(404).json({ error: 'Kein Share gefunden' }); return; }

    getDb().prepare(
      'DELETE FROM extraction_shares WHERE extraction_id = ? AND user_id = ?'
    ).run(extractionId, recipientId);

    getDb().prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(
      req.user!.userId,
      'share_revoked',
      JSON.stringify({ extractionId, recipientUserId: recipientId, recipientName: existing.displayName }),
      req.ip ?? null
    );

    logger.info('Share entzogen', { extractionId, recipientUserId: recipientId, revokedBy: req.user!.userId });
    res.status(204).send();
  }
);

export default router;
```

- [ ] **Step 5: Tests laufen — alle grün**

```bash
cd backend && npm test -- src/routes/__tests__/shares.test.ts
```

Expected: 11 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/shares.ts backend/src/routes/__tests__/shares.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(api): add /api/extractions/:id/shares CRUD with audit"
```

---

## Task 7: Routes `users.ts` (Share-Candidates) (TDD)

**Files:**
- Create: `backend/src/routes/__tests__/users.test.ts`
- Create: `backend/src/routes/users.ts`

- [ ] **Step 1: Tests schreiben**

```ts
// backend/src/routes/__tests__/users.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { getDb } from '../../db/database';
import { setupTestDb } from '../../utils/__tests__/testDb';
import usersRouter from '../users';
import { config } from '../../config';

function tokenFor(userId: number, role: 'user'|'admin' = 'user'): string {
  return jwt.sign({ userId, username: `u${userId}`, role }, config.JWT_SECRET);
}
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/users', usersRouter);
  return app;
}

describe('GET /api/users/share-candidates', () => {
  beforeEach(() => setupTestDb());

  it('returns active users excluding the current user', async () => {
    const res = await request(makeApp())
      .get('/api/users/share-candidates')
      .set('Cookie', [`accessToken=${tokenFor(1)}`]);
    expect(res.status).toBe(200);
    const ids = res.body.map((u: { userId: number }) => u.userId).sort();
    expect(ids).toEqual([2, 3, 4]); // 1 (alice) excluded
    expect(res.body[0]).toHaveProperty('displayName');
    expect(res.body[0]).toHaveProperty('username');
  });

  it('excludes inactive users', async () => {
    getDb().prepare('UPDATE users SET active = 0 WHERE id = 3').run();
    const res = await request(makeApp())
      .get('/api/users/share-candidates')
      .set('Cookie', [`accessToken=${tokenFor(1)}`]);
    const ids = res.body.map((u: { userId: number }) => u.userId);
    expect(ids).not.toContain(3);
  });

  it('requires auth', async () => {
    const res = await request(makeApp()).get('/api/users/share-candidates');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Tests laufen — fail**

```bash
cd backend && npm test -- src/routes/__tests__/users.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implementation**

```ts
// backend/src/routes/users.ts
import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';

const router = Router();

// GET /share-candidates — active users excluding the current one
router.get('/share-candidates', authMiddleware, (req: Request, res: Response): void => {
  const rows = getDb().prepare(
    `SELECT id AS userId, username, display_name AS displayName
     FROM users
     WHERE active = 1 AND id != ?
     ORDER BY display_name`
  ).all(req.user!.userId);
  res.json(rows);
});

export default router;
```

- [ ] **Step 4: Tests laufen — grün**

```bash
cd backend && npm test -- src/routes/__tests__/users.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/users.ts backend/src/routes/__tests__/users.test.ts
git commit -m "feat(api): add /api/users/share-candidates"
```

---

## Task 8: History-UNION für `GET /api/history` (TDD)

**Files:**
- Modify: `backend/src/routes/history.ts`
- Modify: `backend/src/types/api.ts` (add `accessRole`, `ownerName`)
- Modify: `shared/types/api.ts` (mirror)
- Create: `backend/src/routes/__tests__/history.access.test.ts`

- [ ] **Step 1: Test schreiben**

```ts
// backend/src/routes/__tests__/history.access.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { getDb } from '../../db/database';
import { setupTestDb, seedExtraction } from '../../utils/__tests__/testDb';
import historyRouter from '../history';
import { config } from '../../config';

function tokenFor(userId: number, role: 'user'|'admin' = 'user'): string {
  return jwt.sign({ userId, username: `u${userId}`, role }, config.JWT_SECRET);
}
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/history', historyRouter);
  return app;
}

describe('GET /api/history with shared akten', () => {
  beforeEach(() => setupTestDb());

  it('lists own + shared akten with accessRole and ownerName', async () => {
    const own = seedExtraction(2, 'bobs-own.pdf');
    const sharedToBob = seedExtraction(1, 'alices-shared.pdf');
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(sharedToBob, 2, 1);

    const res = await request(makeApp())
      .get('/api/history')
      .set('Cookie', [`accessToken=${tokenFor(2)}`]);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((r: { id: number }) => [r.id, r]));
    expect(byId[own]).toMatchObject({ accessRole: 'owner' });
    expect(byId[own].ownerName).toBeUndefined();
    expect(byId[sharedToBob]).toMatchObject({ accessRole: 'collaborator', ownerName: 'Alice Owner' });
  });

  it('does not show others un-shared akten', async () => {
    seedExtraction(1, 'alices-private.pdf');
    const res = await request(makeApp())
      .get('/api/history')
      .set('Cookie', [`accessToken=${tokenFor(2)}`]);
    expect(res.body).toHaveLength(0);
  });

  it('admin sees all akten with accessRole=admin', async () => {
    seedExtraction(1, 'a.pdf');
    seedExtraction(2, 'b.pdf');
    const res = await request(makeApp())
      .get('/api/history')
      .set('Cookie', [`accessToken=${tokenFor(4, 'admin')}`]);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((r: { accessRole: string }) => r.accessRole === 'admin')).toBe(true);
  });
});
```

- [ ] **Step 2: Test laufen — sollte fehlschlagen (Felder fehlen)**

```bash
cd backend && npm test -- src/routes/__tests__/history.access.test.ts
```

Expected: FAIL — `accessRole` undefined oder Akte nicht gefunden.

- [ ] **Step 3: `history.ts` GET / umbauen — komplett ersetzen**

Replace lines 14-47 of `backend/src/routes/history.ts` with:

```ts
type HistoryRow = {
  id: number; filename: string; file_size: number; status: string;
  stats_found: number; stats_missing: number; stats_letters_ready: number;
  processing_time_ms: number | null; created_at: string;
  progress_message: string | null; progress_percent: number | null;
  access_role: string; owner_name: string | null;
};

router.get('/', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const isAdmin = req.user!.role === 'admin';

  const rows: HistoryRow[] = isAdmin
    ? db.prepare(
        `SELECT e.id, e.filename, e.file_size, e.status, e.stats_found, e.stats_missing,
                e.stats_letters_ready, e.processing_time_ms, e.created_at,
                e.progress_message, e.progress_percent,
                'admin' AS access_role, u.display_name AS owner_name
         FROM extractions e
         JOIN users u ON u.id = e.user_id
         ORDER BY e.created_at DESC LIMIT 100`
      ).all() as HistoryRow[]
    : db.prepare(
        `SELECT e.id, e.filename, e.file_size, e.status, e.stats_found, e.stats_missing,
                e.stats_letters_ready, e.processing_time_ms, e.created_at,
                e.progress_message, e.progress_percent,
                'owner' AS access_role, NULL AS owner_name
         FROM extractions e
         WHERE e.user_id = ?
         UNION ALL
         SELECT e.id, e.filename, e.file_size, e.status, e.stats_found, e.stats_missing,
                e.stats_letters_ready, e.processing_time_ms, e.created_at,
                e.progress_message, e.progress_percent,
                'collaborator' AS access_role, u.display_name AS owner_name
         FROM extractions e
         JOIN extraction_shares s ON s.extraction_id = e.id
         JOIN users u ON u.id = e.user_id
         WHERE s.user_id = ?
         ORDER BY created_at DESC LIMIT 100`
      ).all(userId, userId) as HistoryRow[];

  const items: HistoryItem[] = rows.map(row => ({
    id: row.id,
    filename: row.filename,
    fileSize: row.file_size,
    status: row.status as HistoryItem['status'],
    statsFound: row.stats_found,
    statsMissing: row.stats_missing,
    statsLettersReady: row.stats_letters_ready,
    processingTimeMs: row.processing_time_ms,
    createdAt: row.created_at,
    accessRole: row.access_role as HistoryItem['accessRole'],
    ...(row.owner_name ? { ownerName: row.owner_name } : {}),
    ...(row.status === 'processing' ? {
      progressMessage: row.progress_message,
      progressPercent: row.progress_percent,
    } : {}),
  }));

  res.json(items);
});
```

- [ ] **Step 4: `HistoryItem` erweitern in beiden Type-Dateien**

```ts
// shared/types/api.ts und backend/src/types/api.ts:
export type AccessRole = 'owner' | 'collaborator' | 'admin';

export interface HistoryItem {
  // ... existing fields ...
  accessRole: AccessRole;
  ownerName?: string;
}
```

- [ ] **Step 5: Test laufen — grün + Gesamt-Suite**

```bash
cd backend && npm test -- src/routes/__tests__/history.access.test.ts
cd backend && npm test
```

Expected: 3 passed in der neuen Datei, 126+ Tests in der Gesamt-Suite (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/history.ts backend/src/types/api.ts shared/types/api.ts backend/src/routes/__tests__/history.access.test.ts
git commit -m "feat(history): list owned + shared akten with accessRole + ownerName"
```

---

## Task 9: Bestehende Routes auf Middleware umstellen

**Files:**
- Modify: `backend/src/routes/history.ts` (GET/:id, /pdf, /export, DELETE)
- Modify: `backend/src/routes/fieldUpdate.ts`
- Modify: `backend/src/routes/generateLetter.ts`
- Modify: `backend/src/routes/generateGutachten.ts`
- Modify: `backend/src/routes/documents.ts`

Pro Route: ersetze `WHERE user_id = ?` Logik durch `requireExtractionAccess()`. Bei Owner-only Routes: `requireExtractionAccess({ ownerOnly: true })`.

- [ ] **Step 1: `history.ts` GET /:id umstellen**

In `backend/src/routes/history.ts`, bei dem `router.get('/:id', ...)` Block (ca. Zeile 49-109):

1. Importiere `import { requireExtractionAccess } from '../middleware/extractionAccess';` oben.
2. Ersetze die Middleware-Chain `authMiddleware` durch `authMiddleware, requireExtractionAccess()`.
3. Im Handler: lies `extractionId` aus `req.access!`, entferne den `isAdmin`-Branch und die zwei verschiedenen prepare-Statements — eine einzige Query mit `WHERE id = ?`.

Conkrekter Endcode:

```ts
router.get(
  '/:id',
  authMiddleware,
  requireExtractionAccess(),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const db = getDb();
    const row = db.prepare(
      `SELECT id, filename, file_size, result_json, status, error_message,
              stats_found, stats_missing, stats_letters_ready, processing_time_ms, created_at,
              progress_message, progress_percent
       FROM extractions WHERE id = ?`
    ).get(extractionId) as {
      id: number; filename: string; file_size: number; result_json: string | null;
      status: string; error_message: string | null;
      stats_found: number; stats_missing: number; stats_letters_ready: number;
      processing_time_ms: number | null; created_at: string;
      progress_message: string | null; progress_percent: number | null;
    } | undefined;

    if (!row) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    if (!row.result_json && (row.status === 'expired' || row.status === 'deleted_art17')) {
      const message = row.status === 'expired'
        ? 'Extraktion abgelaufen — bitte .iae-Datei importieren'
        : 'Extraktion gelöscht (Art. 17 DSGVO)';
      res.status(410).json({ error: message, status: row.status });
      return;
    }

    // Resolve ownerName for non-owners (collaborators see who owns the akte)
    const ownerName = req.access!.role !== 'owner'
      ? (db.prepare('SELECT display_name FROM users WHERE id = ?')
           .get(req.access!.ownerId) as { display_name: string } | undefined)?.display_name
      : undefined;

    const response: ExtractionResponse & { progressMessage?: string; progressPercent?: number; accessRole?: string; ownerName?: string } = {
      id: row.id,
      filename: row.filename,
      status: row.status as ExtractionResponse['status'],
      result: readResultJson(row.result_json),
      statsFound: row.stats_found,
      statsMissing: row.stats_missing,
      statsLettersReady: row.stats_letters_ready,
      processingTimeMs: row.processing_time_ms,
      createdAt: row.created_at,
      accessRole: req.access!.role,
      ...(ownerName ? { ownerName } : {}),
      ...(row.progress_message ? {
        progressMessage: row.progress_message,
        progressPercent: row.progress_percent ?? undefined,
      } : {}),
    };

    res.json(response);
  }
);
```

Erweitere zusätzlich den `ExtractionResponse` Type in `backend/src/types/api.ts` und `shared/types/api.ts`:

```ts
export interface ExtractionResponse {
  // ... existing fields ...
  accessRole?: AccessRole;  // server may include access metadata
  ownerName?: string;
}
```

- [ ] **Step 2: `history.ts` /pdf umstellen**

Replace the `router.get('/:id/pdf', ...)` block (ca. Zeile 112-144):

```ts
router.get(
  '/:id/pdf',
  authMiddleware,
  requireExtractionAccess(),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const db = getDb();
    const row = db.prepare('SELECT id, filename FROM extractions WHERE id = ?').get(extractionId) as { id: number; filename: string } | undefined;
    if (!row) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

    const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
    const extractionPdfDir = path.join(pdfDir, String(extractionId));
    let pdfPath = path.join(extractionPdfDir, '0_gerichtsakte.pdf');
    if (!fs.existsSync(pdfPath)) pdfPath = path.join(pdfDir, `${extractionId}.pdf`);
    if (!fs.existsSync(pdfPath)) { res.status(404).json({ error: 'PDF nicht mehr verfügbar' }); return; }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
    fs.createReadStream(pdfPath).pipe(res);
  }
);
```

- [ ] **Step 3: `history.ts` /export auf ownerOnly**

Replace the `router.post('/:id/export', ...)` block:

```ts
router.post(
  '/:id/export',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const userId = req.user!.userId;
    const db = getDb();

    const { password } = req.body as { password?: string };
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
      return;
    }

    const row = db.prepare(
      `SELECT id, filename, result_json, status, stats_found, stats_missing, stats_letters_ready, created_at
       FROM extractions WHERE id = ?`
    ).get(extractionId) as {
      id: number; filename: string; result_json: string | null; status: string;
      stats_found: number; stats_missing: number; stats_letters_ready: number;
      created_at: string;
    } | undefined;

    if (!row)               { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }
    if (!row.result_json)   { res.status(410).json({ error: 'Extraktionsdaten nicht mehr verfügbar' }); return; }

    const decryptedJson = JSON.stringify(readResultJson(row.result_json));
    const encrypted = encrypt(decryptedJson, password);

    const exportData = {
      version: 1,
      format: 'insolvenz-akte-export',
      encrypted: true,
      salt: encrypted.salt,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      data: encrypted.data,
      metadata: {
        filename: row.filename,
        exportedAt: new Date().toISOString(),
        statsFound: row.stats_found,
        statsMissing: row.stats_missing,
      },
    };

    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(userId, 'export', JSON.stringify({ extractionId, filename: row.filename }), req.ip);

    logger.info('Extraktion exportiert', { extractionId, userId });

    const sanitizedName = row.filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9äöüÄÖÜß_\-. ]/g, '_');
    const exportFilename = sanitizedName + '.iae';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportFilename)}`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  }
);
```

- [ ] **Step 4: `history.ts` DELETE /:id auf ownerOnly + Share-Cleanup**

```ts
router.delete(
  '/:id',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const userId = req.user!.userId;
    const db = getDb();

    const row = db.prepare('SELECT id, filename FROM extractions WHERE id = ?').get(extractionId) as { id: number; filename: string } | undefined;
    if (!row) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    db.prepare(`UPDATE extractions SET result_json = NULL, status = 'deleted_art17' WHERE id = ?`).run(extractionId);
    db.prepare('DELETE FROM extraction_shares WHERE extraction_id = ?').run(extractionId);

    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(userId, 'deletion_art17', JSON.stringify({ extractionId, filename: row.filename }), req.ip);

    logger.info('Extraktion gelöscht (Art. 17 DSGVO)', { extractionId, userId });
    res.status(204).send();
  }
);
```

- [ ] **Step 5: `fieldUpdate.ts`, `generateLetter.ts`, `generateGutachten.ts`, `documents.ts` umstellen**

In jeder Datei das gleiche Pattern:

1. `import { requireExtractionAccess } from '../middleware/extractionAccess';` oben hinzufügen.
2. Bei jedem Route, der mit `:id` oder `:extractionId` operiert: `requireExtractionAccess()` zwischen `authMiddleware` und Handler einfügen.
3. Im Handler: `const { extractionId } = req.access!;` statt manuelles `parseInt(req.params['id'])`.
4. Entferne den manuellen `WHERE user_id = ?` Check (Middleware hat das schon erledigt).

Vorher → Nachher Pattern:

```ts
// VORHER
router.post('/:id/...', authMiddleware, async (req, res) => {
  const id = parseInt(parseParam(req.params['id']), 10);
  if (isNaN(id)) { res.status(400)...; return; }
  const userId = req.user!.userId;
  const row = db.prepare('SELECT * FROM extractions WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) { res.status(404)...; return; }
  // ... handler logic uses id ...
});

// NACHHER
router.post('/:id/...',
  authMiddleware,
  requireExtractionAccess(),
  async (req, res) => {
    const { extractionId } = req.access!;
    const row = db.prepare('SELECT * FROM extractions WHERE id = ?').get(extractionId);
    if (!row) { res.status(404)...; return; }
    // ... handler logic uses extractionId ...
  }
);
```

- [ ] **Step 6: Tests laufen — keine Regressionen**

```bash
cd backend && npm test
```

Expected: 126+ Tests grün. Falls bestehende Tests in `documentMerge.test.ts` o.ä. dabei brechen, schaue ob sie eine `extractions`-Row erwarten die noch nicht via `setupTestDb` existiert — diese Tests stubben mit eigenem In-Memory-DB, sollten unberührt bleiben.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/history.ts backend/src/routes/fieldUpdate.ts backend/src/routes/generateLetter.ts backend/src/routes/generateGutachten.ts backend/src/routes/documents.ts backend/src/types/api.ts shared/types/api.ts
git commit -m "refactor(routes): use requireExtractionAccess middleware on extraction-scoped routes"
```

---

## Task 10: Routes mounten in `index.ts`

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Imports hinzufügen**

After line 21 (after letterTemplatesRoutes import):

```ts
import sharesRoutes from './routes/shares';
import usersRoutes from './routes/users';
```

- [ ] **Step 2: Routen mounten**

After line 47 (after letter-templates mount):

```ts
app.use('/api/extractions', sharesRoutes);
app.use('/api/users', usersRoutes);
```

- [ ] **Step 3: Backend-Build prüfen**

```bash
cd backend && npm run build
```

Expected: keine TS-Fehler.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(api): mount shares + users routers"
```

---

## Task 11: Frontend Shared Types

**Files:**
- Verify: `shared/types/api.ts` schon in Task 8 angepasst, `accessRole`/`ownerName` auf `HistoryItem` und `ExtractionResponse`
- Verify: Frontend `tsc -b && vite build` läuft sauber

- [ ] **Step 1: Build im Frontend**

```bash
cd frontend && npm run build
```

Expected: build success, accessRole/ownerName Types sichtbar. Falls neue TS-Fehler auftauchen weil Konsumenten den `accessRole` strict erwarten — dort optional defaulten oder Type erweitern (Felder sind optional auf der Type-Seite).

- [ ] **Step 2: Commit (falls Änderung)**

Wenn keine Frontend-Änderung nötig — skip.

---

## Task 12: Frontend API-Wrapper `shares.ts`

**Files:**
- Create: `frontend/src/api/shares.ts`

- [ ] **Step 1: Vor-Check welcher API-Client-Name verwendet wird**

```bash
head -15 /Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/.worktrees/akten-teilen/frontend/src/api/client.ts
```

Suche nach `export const apiClient` oder `export default ...`. Den exakten Namen verwenden.

- [ ] **Step 2: Wrapper schreiben (Beispiel mit `apiClient`)**

```ts
// frontend/src/api/shares.ts
import { apiClient } from './client';

export interface ExtractionShare {
  userId: number;
  displayName: string;
  username: string;
  grantedBy: number;
  grantedAt: string;
}

export interface ShareCandidate {
  userId: number;
  username: string;
  displayName: string;
}

export async function listShares(extractionId: number): Promise<ExtractionShare[]> {
  const res = await apiClient.get(`/extractions/${extractionId}/shares`);
  return res.data;
}

export async function grantShare(extractionId: number, userId: number): Promise<ExtractionShare> {
  const res = await apiClient.post(`/extractions/${extractionId}/shares`, { userId });
  return res.data;
}

export async function revokeShare(extractionId: number, userId: number): Promise<void> {
  await apiClient.delete(`/extractions/${extractionId}/shares/${userId}`);
}

export async function listShareCandidates(): Promise<ShareCandidate[]> {
  const res = await apiClient.get('/users/share-candidates');
  return res.data;
}
```

Falls der Client anders heißt (z. B. `api`, `axios`-Instanz, Default-Export), entsprechend anpassen.

- [ ] **Step 3: Build prüfen**

```bash
cd frontend && npm run build
```

Expected: kein TS-Fehler.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/shares.ts
git commit -m "feat(frontend): add shares API client"
```

---

## Task 13: ShareModal-Komponente

**Files:**
- Create: `frontend/src/components/share/ShareModal.tsx`

- [ ] **Step 1: Komponente schreiben**

```tsx
// frontend/src/components/share/ShareModal.tsx
import { useEffect, useState } from 'react';
import {
  listShares, grantShare, revokeShare, listShareCandidates,
  type ExtractionShare, type ShareCandidate,
} from '../../api/shares';

interface Props {
  extractionId: number;
  open: boolean;
  onClose: () => void;
}

export function ShareModal({ extractionId, open, onClose }: Props) {
  const [shares, setShares] = useState<ExtractionShare[]>([]);
  const [candidates, setCandidates] = useState<ShareCandidate[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    Promise.all([listShares(extractionId), listShareCandidates()])
      .then(([s, c]) => { setShares(s); setCandidates(c); })
      .catch(e => setError(e?.response?.data?.error ?? 'Laden fehlgeschlagen'));
  }, [open, extractionId]);

  if (!open) return null;

  const sharedIds = new Set(shares.map(s => s.userId));
  const filtered = candidates
    .filter(c => !sharedIds.has(c.userId))
    .filter(c => c.displayName.toLowerCase().includes(filter.toLowerCase()));

  async function handleGrant(userId: number) {
    setBusy(true); setError(null);
    try {
      const s = await grantShare(extractionId, userId);
      setShares(prev => [...prev, s]);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Teilen fehlgeschlagen');
    } finally { setBusy(false); }
  }

  async function handleRevoke(userId: number) {
    setBusy(true); setError(null);
    try {
      await revokeShare(extractionId, userId);
      setShares(prev => prev.filter(s => s.userId !== userId));
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Entziehen fehlgeschlagen');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl p-6 w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-medium mb-4">Akte teilen</h2>

        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}

        <section className="mb-5">
          <h3 className="text-sm font-medium text-stone-700 mb-2">Aktuell geteilt mit</h3>
          {shares.length === 0 && <p className="text-sm text-stone-500">Noch niemand</p>}
          <ul className="space-y-1">
            {shares.map(s => (
              <li key={s.userId} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-stone-50">
                <span className="text-sm">{s.displayName}</span>
                <button
                  onClick={() => handleRevoke(s.userId)}
                  disabled={busy}
                  className="text-xs text-red-700 hover:text-red-900 disabled:opacity-50"
                  aria-label={`Zugriff für ${s.displayName} entziehen`}
                >Entziehen</button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-sm font-medium text-stone-700 mb-2">Teilen mit</h3>
          <input
            type="search"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Name suchen…"
            className="w-full mb-2 px-3 py-2 border border-stone-300 rounded-lg text-sm"
          />
          <ul className="max-h-48 overflow-y-auto space-y-1">
            {filtered.map(c => (
              <li key={c.userId} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-stone-50">
                <span className="text-sm">{c.displayName}</span>
                <button
                  onClick={() => handleGrant(c.userId)}
                  disabled={busy}
                  className="text-xs text-[#A52A2A] hover:underline disabled:opacity-50"
                >Teilen</button>
              </li>
            ))}
            {filtered.length === 0 && <li className="text-sm text-stone-500 px-2">Keine Treffer</li>}
          </ul>
        </section>

        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-stone-700 hover:text-stone-900">Schließen</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build prüfen**

```bash
cd frontend && npm run build
```

Expected: kein TS-Fehler.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/share/ShareModal.tsx
git commit -m "feat(frontend): add ShareModal component"
```

---

## Task 14: ShareModal in Akte-Detail integrieren + CollaboratorBanner

**Files:**
- Create: `frontend/src/components/share/CollaboratorBanner.tsx`
- Modify: Akte-Detail-Page (vermutlich `frontend/src/pages/DashboardPage.tsx` oder Sub-Komponente)

- [ ] **Step 1: CollaboratorBanner schreiben**

```tsx
// frontend/src/components/share/CollaboratorBanner.tsx
interface Props {
  ownerName: string;
}
export function CollaboratorBanner({ ownerName }: Props) {
  return (
    <div className="bg-blue-50 border border-blue-200 text-blue-900 text-sm px-4 py-2 rounded-lg mb-3">
      <span className="font-medium">Co-Bearbeitung</span> — Eigentümer: {ownerName}
    </div>
  );
}
```

- [ ] **Step 2: Akte-Detail finden + integrieren**

```bash
grep -n "ExtractionResponse\|HistoryItem" /Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/.worktrees/akten-teilen/frontend/src/pages/DashboardPage.tsx /Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/.worktrees/akten-teilen/frontend/src/hooks/useExtraction.ts 2>/dev/null
```

Erwartung: in `useExtraction.ts` wird `ExtractionResponse` verarbeitet — `accessRole` und `ownerName` propagieren in den State.

In der Detail-View (Übersicht-Tab Header) ergänzen:

```tsx
import { useState } from 'react';
import { ShareModal } from '../share/ShareModal';
import { CollaboratorBanner } from '../share/CollaboratorBanner';

// in der Komponente:
const [shareOpen, setShareOpen] = useState(false);

// in JSX, nahe dem Akte-Header:
{extraction.accessRole === 'collaborator' && extraction.ownerName && (
  <CollaboratorBanner ownerName={extraction.ownerName} />
)}
{(extraction.accessRole === 'owner' || extraction.accessRole === 'admin') && (
  <button
    onClick={() => setShareOpen(true)}
    className="text-sm text-[#A52A2A] hover:underline"
  >Teilen</button>
)}
<ShareModal
  extractionId={extraction.id}
  open={shareOpen}
  onClose={() => setShareOpen(false)}
/>
```

- [ ] **Step 3: Build im Frontend**

```bash
cd frontend && npm run build
```

Expected: kein TS-Fehler.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/share/CollaboratorBanner.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat(frontend): wire ShareModal + CollaboratorBanner into Akte-Detail"
```

---

## Task 15: HistoryPanel Pill für Collaborator-Akten

**Files:**
- Modify: `frontend/src/components/dashboard/HistoryPanel.tsx`

- [ ] **Step 1: Pill rendern**

In der Item-Render-Funktion einsetzen:

```tsx
{item.accessRole === 'collaborator' && item.ownerName && (
  <span className="ml-2 inline-flex items-center px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-800 border border-blue-200">
    Geteilt von {item.ownerName}
  </span>
)}
```

Optional Hintergrund-Tönung am Container:

```tsx
<div className={`... ${item.accessRole === 'collaborator' ? 'bg-blue-50/30' : ''}`}>
```

- [ ] **Step 2: Build im Frontend**

```bash
cd frontend && npm run build
```

Expected: kein TS-Fehler.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/HistoryPanel.tsx
git commit -m "feat(frontend): show 'Geteilt von X' pill on shared akten in history"
```

---

## Task 16: AccessLogTab (Zugriffsprotokoll) — Backend + Frontend

**Files:**
- Modify: `backend/src/routes/shares.ts` (neuer Read-Endpoint)
- Create: `backend/src/routes/__tests__/shares.audit.test.ts`
- Create: `frontend/src/components/share/AccessLogTab.tsx`

- [ ] **Step 1: Backend-Endpoint testen — Test schreiben**

```ts
// backend/src/routes/__tests__/shares.audit.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { getDb } from '../../db/database';
import { setupTestDb, seedExtraction } from '../../utils/__tests__/testDb';
import sharesRouter from '../shares';
import { config } from '../../config';

function tokenFor(userId: number, role: 'user'|'admin' = 'user'): string {
  return jwt.sign({ userId, username: `u${userId}`, role }, config.JWT_SECRET);
}
function makeApp() {
  const app = express();
  app.use(express.json()); app.use(cookieParser());
  app.use('/api/extractions', sharesRouter);
  return app;
}

describe('GET /api/extractions/:id/access-log', () => {
  beforeEach(() => setupTestDb());

  it('returns chronological audit entries for owner', async () => {
    const id = seedExtraction(1);
    getDb().prepare(
      'INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)'
    ).run(2, 'share_read', JSON.stringify({ extractionId: id, role: 'collaborator' }));
    getDb().prepare(
      'INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)'
    ).run(1, 'share_granted', JSON.stringify({ extractionId: id, recipientUserId: 2 }));

    const res = await request(makeApp())
      .get(`/api/extractions/${id}/access-log`)
      .set('Cookie', [`accessToken=${tokenFor(1, 'user')}`]);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ action: expect.stringMatching(/^share_/) });
    expect(res.body[0]).toHaveProperty('actorName');
  });

  it('returns 403 for collaborator', async () => {
    const id = seedExtraction(1);
    getDb().prepare('INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, 2, 1);
    const res = await request(makeApp())
      .get(`/api/extractions/${id}/access-log`)
      .set('Cookie', [`accessToken=${tokenFor(2, 'user')}`]);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Endpoint in `shares.ts` ergänzen — VOR `export default`**

```ts
// backend/src/routes/shares.ts — NEUER Block VOR `export default router;`
router.get(
  '/:id/access-log',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const rows = getDb().prepare(
      `SELECT a.id, a.user_id AS userId, u.display_name AS actorName,
              a.action, a.details, a.created_at AS createdAt
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.action IN ('share_read','share_edit','share_granted','share_revoked')
         AND json_extract(a.details, '$.extractionId') = ?
       ORDER BY a.id DESC LIMIT 200`
    ).all(extractionId);
    res.json(rows);
  }
);
```

- [ ] **Step 3: Tests laufen — grün**

```bash
cd backend && npm test -- src/routes/__tests__/shares.audit.test.ts
```

Expected: 2 passed.

- [ ] **Step 4: Frontend-Tab schreiben**

```tsx
// frontend/src/components/share/AccessLogTab.tsx
import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

interface LogEntry {
  id: number;
  userId: number | null;
  actorName: string | null;
  action: 'share_read' | 'share_edit' | 'share_granted' | 'share_revoked';
  details: string;
  createdAt: string;
}

const ACTION_LABEL: Record<LogEntry['action'], string> = {
  share_read: 'Aufruf',
  share_edit: 'Änderung',
  share_granted: 'Geteilt',
  share_revoked: 'Entzogen',
};

export function AccessLogTab({ extractionId }: { extractionId: number }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient.get(`/extractions/${extractionId}/access-log`)
      .then(r => setEntries(r.data))
      .catch(e => setError(e?.response?.data?.error ?? 'Laden fehlgeschlagen'));
  }, [extractionId]);

  if (error) return <div className="text-sm text-red-700">{error}</div>;
  if (entries.length === 0) return <div className="text-sm text-stone-500">Noch keine Zugriffe protokolliert.</div>;

  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-stone-500 uppercase">
        <tr><th className="text-left py-2">Wann</th><th className="text-left">Wer</th><th className="text-left">Aktion</th><th className="text-left">Details</th></tr>
      </thead>
      <tbody>
        {entries.map(e => {
          let detail = '';
          try {
            const d = JSON.parse(e.details);
            detail = d.method ? `${d.method} ${d.path ?? ''}` : (d.recipientName ? `Empfänger: ${d.recipientName}` : '');
          } catch { /* ignore */ }
          return (
            <tr key={e.id} className="border-t border-stone-100">
              <td className="py-1.5">{new Date(e.createdAt).toLocaleString('de-DE')}</td>
              <td>{e.actorName ?? '—'}</td>
              <td>{ACTION_LABEL[e.action] ?? e.action}</td>
              <td className="text-stone-600 text-xs">{detail}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 5: AccessLogTab in die Tab-Bar der Akte-Detail einbauen (Owner+Admin only)**

Locate Tab-Definitionen (vermutlich in `DashboardPage.tsx` oder einem Tabs-Konfig-Array). Conditional ergänzen:

```tsx
{(extraction.accessRole === 'owner' || extraction.accessRole === 'admin') && (
  <Tab name="zugriff" label="Zugriff">
    <AccessLogTab extractionId={extraction.id} />
  </Tab>
)}
```

(Falls die Tabs-Komponente anders strukturiert ist — z. B. Liste von Konfig-Objekten — entsprechend anpassen. Pattern bleibt: Conditional Render basierend auf `accessRole`.)

- [ ] **Step 6: Frontend Build**

```bash
cd frontend && npm run build
```

Expected: kein TS-Fehler.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/shares.ts backend/src/routes/__tests__/shares.audit.test.ts frontend/src/components/share/AccessLogTab.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat(audit): GET /access-log endpoint + AccessLogTab UI for owner+admin"
```

---

## Task 17: Manuelle Verifikation auf Demo

**Files:** keine — manuelle Testschritte.

- [ ] **Step 1: Branch pushen + PR auf dev öffnen**

```bash
git push -u origin feature/akten-teilen
gh pr create --base dev --head feature/akten-teilen --title "feat: akten-teilen between sachbearbeiter" --body "$(cat <<'EOF'
## Summary
- Co-edit sharing of extractions zwischen Sachbearbeitern
- Owner-only: Delete (Art. 17), .iae-Export, Re-Share/Revoke
- Full audit auf collaborator + admin reads/edits via Middleware-Hook
- Späteres Team-Modell pluggt via paralleler Tabelle ein, ohne Schema-Refactor

Spec: docs/superpowers/specs/2026-04-30-akten-teilen-design.md
Plan: docs/superpowers/plans/2026-04-30-akten-teilen.md

## Test plan
- [ ] CI grün (backend vitest + frontend tsc/vite build)
- [ ] Demo-Server: 2 Test-User, alice teilt mit bob
- [ ] bob sieht Akte mit "Geteilt von Alice" Pill in Historie
- [ ] bob editiert ein Feld -> audit_log enthält share_edit
- [ ] bob versucht Delete -> 403 OWNER_ONLY
- [ ] alice revoked -> bob sieht Akte nicht mehr (refresh)
- [ ] alice deletet Art. 17 -> bob sieht Akte nicht mehr
- [ ] alice öffnet Zugriff-Tab -> bobs Reads/Edits sichtbar

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Nach Merge in dev → Promote auf demo**

Über GitHub Actions UI: Actions → "Promote main → demo" → Run workflow (sobald in main gemerged), oder vorab manuell auf einer Test-VM checken.

- [ ] **Step 3: Manuelle Verifikations-Checkliste auf demo**

Login als alice (Test-User), upload akte. Login als bob in zweitem Browser. Steps:

1. alice: "Teilen" → bob auswählen → POST → "Geteilt mit Bob" Toast
2. bob: refresh History → sieht alices Akte mit Pill
3. bob: öffnet Akte → sieht CollaboratorBanner "Co-Bearbeitung — Eigentümer: Alice"
4. bob: editiert ein Feld → speichert → ok
5. alice: öffnet Akte, Tab "Zugriff" → sieht "Aufruf" + "Änderung" mit bob als Wer
6. bob: versucht Delete → 403 OWNER_ONLY
7. bob: versucht POST `/api/extractions/:id/shares` via curl → 403 OWNER_ONLY
8. alice: "Teilen" → bob "Entziehen" → Toast
9. bob: refresh → Akte weg aus Historie
10. alice: löscht Akte (Art. 17) → bob: refresh History → keine Spur

- [ ] **Step 4: Falls grün → PR dev → main**

```bash
gh pr create --base main --head dev --title "release: akten-teilen" --body "Promotes akten-teilen to prod after demo verification."
```

---

## Self-Review

**Spec coverage check:**
- ✓ Schema (Section "Schema" in spec) → Task 1
- ✓ Authorization Layer (helper + middleware + 404/403) → Tasks 3, 4, 5
- ✓ API Surface (shares CRUD + share-candidates + history UNION) → Tasks 6, 7, 8, 10
- ✓ Bestehende Routes auf Middleware umgestellt → Task 9
- ✓ UI/UX (ShareModal, Pill, CollaboratorBanner, AccessLogTab) → Tasks 13, 14, 15, 16
- ✓ Audit-Schema (4 actions: share_granted, share_revoked, share_read, share_edit) → Task 5 (auto-audit) + Task 6 (explicit grant/revoke) + Task 16 (access-log read endpoint)
- ✓ Migration & Rollout (Migration in Task 1, Rollout in Task 17)
- ✓ Security & Edge Cases (404/403, self-share, doppel-share, inactive user, Art-17-cleanup) → Tests in Task 6 + Cleanup-Code in Task 9

**Type consistency:**
- `AccessRole` einheitlich `'owner' | 'collaborator' | 'admin'` in Helper, Middleware, History, Frontend
- `ExtractionShare` shape gleich in Backend-Response (Task 6) und Frontend-Type (Task 12)
- `req.access` wird via `declare global` einmalig deklariert in Task 4
- `accessibleExtractionIds` kommt im Helper (Task 3) — wird in der initialen Implementierung nicht direkt aufgerufen (UNION-Query in Task 8 reicht). Wird beibehalten als Baustein für zukünftige Filter-Endpunkte; falls beim Reviewer als YAGNI verworfen, kann Task 3 entsprechend gekürzt werden.

**Placeholder scan:** keine "TBD/TODO/Add appropriate" gefunden. Lokalisations-Anweisungen in Task 14 und 16 (z. B. "vermutlich `DashboardPage.tsx`") sind Routing-Hinweise an den Agenten, kein Platzhalter — der Agent muss `grep` ausführen.

**Bekannte Lücken (bewusst):**
- Frontend hat keine vitest-Setup → wir verifizieren via Build statt Unit-Tests. Repo-Konvention.
- `accessibleExtractionIds` Helper aus Task 3 wird in Task 8 nicht direkt verwendet (UNION-Query ist effizienter). Helper bleibt für API-Vollständigkeit + spätere Use-Cases.
