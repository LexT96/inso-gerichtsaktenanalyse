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
