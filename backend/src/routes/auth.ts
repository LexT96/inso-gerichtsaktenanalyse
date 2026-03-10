import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/database';
import { loginSchema, refreshSchema } from '../utils/validation';
import { logger } from '../utils/logger';
import { authRateLimit } from '../middleware/rateLimit';
import type { JwtPayload, LoginResponse, RefreshResponse } from '../types/api';

const router = Router();

function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([mhd])$/);
  if (!match) return 15 * 60 * 1000;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return parseInt(num, 10) * (multipliers[unit] || 60_000);
}

router.post('/login', authRateLimit, async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Ungültige Eingabedaten' });
      return;
    }

    const { username, password } = parsed.data;
    const db = getDb();

    const user = db.prepare(
      'SELECT id, username, password_hash, display_name, role, active FROM users WHERE username = ?'
    ).get(username) as { id: number; username: string; password_hash: string; display_name: string; role: string; active: number } | undefined;

    if (!user || !user.active) {
      res.status(401).json({ error: 'Ungültige Anmeldedaten' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      logger.warn('Fehlgeschlagener Login', { username, ip: req.ip });
      res.status(401).json({ error: 'Ungültige Anmeldedaten' });
      return;
    }

    const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role };
    const expiresIn = config.JWT_ACCESS_EXPIRY;
    const accessToken = jwt.sign(payload, config.JWT_SECRET, { expiresIn } as jwt.SignOptions);

    const refreshToken = uuidv4();
    const refreshExpiresAt = new Date(Date.now() + parseExpiry(config.JWT_REFRESH_EXPIRY)).toISOString();

    db.prepare(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, refreshToken, refreshExpiresAt);

    // Audit log
    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'login', JSON.stringify({ username: user.username }), req.ip);

    const response: LoginResponse = {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      },
    };

    logger.info('Erfolgreicher Login', { userId: user.id, username: user.username });
    res.json(response);
  } catch {
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/refresh', (req: Request, res: Response): void => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Refresh Token erforderlich' });
    return;
  }

  const db = getDb();
  // Cleanup expired refresh tokens to prevent unbounded DB growth
  db.prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')").run();
  const stored = db.prepare(
    `SELECT rt.id, rt.user_id, rt.expires_at, u.username, u.role, u.active
     FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id
     WHERE rt.token = ?`
  ).get(parsed.data.refreshToken) as {
    id: number; user_id: number; expires_at: string;
    username: string; role: string; active: number;
  } | undefined;

  if (!stored || !stored.active) {
    res.status(401).json({ error: 'Ungültiges Refresh Token' });
    return;
  }

  if (new Date(stored.expires_at) < new Date()) {
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id);
    res.status(401).json({ error: 'Refresh Token abgelaufen' });
    return;
  }

  // Rotate: delete old refresh token and issue a new one
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id);

  const payload: JwtPayload = { userId: stored.user_id, username: stored.username, role: stored.role };
  const accessToken = jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_ACCESS_EXPIRY } as jwt.SignOptions);

  const newRefreshToken = uuidv4();
  const refreshExpiresAt = new Date(Date.now() + parseExpiry(config.JWT_REFRESH_EXPIRY)).toISOString();
  db.prepare(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).run(stored.user_id, newRefreshToken, refreshExpiresAt);

  const response: RefreshResponse = { accessToken, refreshToken: newRefreshToken };
  res.json(response);
});

export default router;
