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
