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
