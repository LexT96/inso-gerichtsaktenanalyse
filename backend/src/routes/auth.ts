import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { getDb } from '../db/database';
import { loginSchema, registerSchema } from '../utils/validation';
import { logger } from '../utils/logger';
import { authRateLimit } from '../middleware/rateLimit';
import { authMiddleware } from '../middleware/auth';
import type { JwtPayload } from '../types/api';

const router = Router();

const isEntraEnabled = (): boolean =>
  Boolean(config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID);

/**
 * Check if an email domain is in the AZURE_ALLOWED_DOMAINS list.
 * Used for both Entra ID and local registration domain gating.
 */
function isRegistrationDomainAllowed(email: string): boolean {
  const allowed = process.env.AZURE_ALLOWED_DOMAINS;
  if (!allowed) return true;
  const domains = allowed.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  if (domains.length === 0) return true;
  const userDomain = email.split('@')[1]?.toLowerCase();
  return domains.includes(userDomain);
}

// ─── Auth mode endpoint — tells the frontend which login flow to use ───

router.get('/mode', (_req: Request, res: Response): void => {
  // hybrid = both Entra SSO and local email/password are available
  res.json({ mode: isEntraEnabled() ? 'hybrid' : 'local' });
});

// ─── /auth/me — returns the current user from token (works for both Entra and local) ───

router.get('/me', authMiddleware, (req: Request, res: Response): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Nicht authentifiziert' });
    return;
  }

  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, display_name, role FROM users WHERE id = ?'
  ).get(req.user.userId) as { id: number; username: string; display_name: string; role: string } | undefined;

  if (!user) {
    res.status(404).json({ error: 'Benutzer nicht gefunden' });
    return;
  }

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    },
  });
});

// ─── Local auth helpers ───

function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([mhd])$/);
  if (!match) return 15 * 60 * 1000;
  const [, num, unit] = match;
  const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
  return parseInt(num, 10) * (multipliers[unit] || 60_000);
}

const isProduction = config.NODE_ENV === 'production';

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api',
    maxAge: parseExpiry(config.JWT_ACCESS_EXPIRY),
  });
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/api/auth/refresh',
    maxAge: parseExpiry(config.JWT_REFRESH_EXPIRY),
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('accessToken', { path: '/api' });
  res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
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
    const accessToken = jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_ACCESS_EXPIRY } as jwt.SignOptions);

    const refreshToken = uuidv4();
    const refreshExpiresAt = new Date(Date.now() + parseExpiry(config.JWT_REFRESH_EXPIRY)).toISOString();

    db.prepare(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, refreshToken, refreshExpiresAt);

    // Limit active sessions per user (keep newest 5, purge old)
    db.prepare(
      `DELETE FROM refresh_tokens WHERE user_id = ? AND id NOT IN (
        SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 5
      )`
    ).run(user.id, user.id);

    // Audit log
    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'login', JSON.stringify({ username: user.username }), req.ip);

    setAuthCookies(res, accessToken, refreshToken);

    logger.info('Erfolgreicher Login', { userId: user.id, username: user.username });
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
      },
    });
  } catch {
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/refresh', (req: Request, res: Response): void => {
  const refreshTokenValue = req.cookies?.refreshToken;
  if (!refreshTokenValue) {
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
  ).get(refreshTokenValue) as {
    id: number; user_id: number; expires_at: string;
    username: string; role: string; active: number;
  } | undefined;

  if (!stored || !stored.active) {
    clearAuthCookies(res);
    res.status(401).json({ error: 'Ungültiges Refresh Token' });
    return;
  }

  if (new Date(stored.expires_at) < new Date()) {
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(stored.id);
    clearAuthCookies(res);
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

  setAuthCookies(res, accessToken, newRefreshToken);
  res.json({ ok: true });
});

// ─── Registration ───

router.post('/register', authRateLimit, async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]?.message || 'Ungültige Eingabedaten';
      res.status(400).json({ error: firstError });
      return;
    }

    const { email, password, displayName } = parsed.data;

    // Domain restriction: only allowed email domains can register
    if (!isRegistrationDomainAllowed(email)) {
      res.status(403).json({ error: 'Registrierung ist nur mit einer autorisierten E-Mail-Domain möglich.' });
      return;
    }

    const db = getDb();

    // Check if email already exists
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(email);
    if (existing) {
      res.status(409).json({ error: 'Ein Konto mit dieser E-Mail-Adresse existiert bereits.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role, active) VALUES (?, ?, ?, ?, 1)'
    ).run(email, passwordHash, displayName, 'user');

    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(result.lastInsertRowid, 'register', JSON.stringify({ email }), req.ip);

    logger.info('Neuer Benutzer registriert', { email });
    res.status(201).json({ ok: true });
  } catch (err) {
    logger.error('Registrierung fehlgeschlagen', { error: String(err) });
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

router.post('/logout', (req: Request, res: Response): void => {
  // Clean up refresh tokens for local-auth sessions
  const refreshTokenValue = req.cookies?.refreshToken;
  if (refreshTokenValue) {
    const db = getDb();
    db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshTokenValue);
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

export default router;
