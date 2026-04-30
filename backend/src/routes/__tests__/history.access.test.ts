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
