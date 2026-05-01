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
  app.use(express.json());
  app.use(cookieParser());
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
