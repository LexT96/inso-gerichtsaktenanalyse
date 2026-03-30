import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { config } from '../config';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import type { JwtPayload } from '../types/api';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ─── Entra ID (Azure AD) token validation ───

const isEntraEnabled = (): boolean =>
  Boolean(config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID);

let jwksClientInstance: jwksRsa.JwksClient | null = null;

function getJwksClient(): jwksRsa.JwksClient {
  if (!jwksClientInstance) {
    jwksClientInstance = new jwksRsa.JwksClient({
      jwksUri: `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      rateLimit: true,
    });
  }
  return jwksClientInstance;
}

function getEntraSigningKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  getJwksClient().getSigningKey(header.kid, (err: Error | null, key?: jwksRsa.SigningKey) => {
    if (err) return callback(err);
    callback(null, key?.getPublicKey());
  });
}

function verifyEntraToken(token: string): Promise<jwt.JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getEntraSigningKey,
      {
        audience: `api://${config.AZURE_CLIENT_ID}`,
        issuer: `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}/v2.0`,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded as jwt.JwtPayload);
      }
    );
  });
}

/**
 * Upsert user from Entra ID token claims into SQLite.
 * Uses `oid` (Azure Object ID) as the stable user identifier.
 * Returns the local user record with id, username, role.
 */
function upsertEntraUser(claims: jwt.JwtPayload): JwtPayload {
  const db = getDb();
  const oid = claims.oid as string;
  const email = (claims.preferred_username || claims.email || claims.upn || oid) as string;
  const displayName = (claims.name || email) as string;

  // Check if user exists by azure_oid
  const existing = db.prepare(
    'SELECT id, username, role FROM users WHERE azure_oid = ?'
  ).get(oid) as { id: number; username: string; role: string } | undefined;

  if (existing) {
    // Update display name and email on each login
    db.prepare(
      'UPDATE users SET display_name = ?, username = ?, updated_at = CURRENT_TIMESTAMP WHERE azure_oid = ?'
    ).run(displayName, email, oid);
    return { userId: existing.id, username: existing.username, role: existing.role };
  }

  // Auto-create new user from Entra ID claims
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role, active, azure_oid) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(email, '', displayName, 'user', oid);

  logger.info('Entra ID Benutzer automatisch erstellt', { email, oid });
  return { userId: result.lastInsertRowid as number, username: email, role: 'user' };
}

// ─── Local JWT validation (legacy/fallback) ───

function verifyLocalToken(token: string): JwtPayload {
  return jwt.verify(token, config.JWT_SECRET) as JwtPayload;
}

// ─── Unified auth middleware ───

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Read token from Authorization header (primary for Entra ID) or HTTP-only cookie (fallback for local auth)
  const token = (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined)
    || req.cookies?.accessToken;

  if (!token) {
    res.status(401).json({ error: 'Authentifizierung erforderlich' });
    return;
  }

  if (isEntraEnabled()) {
    // Try Entra ID token validation first
    verifyEntraToken(token)
      .then((claims) => {
        req.user = upsertEntraUser(claims);
        next();
      })
      .catch((entraErr) => {
        // If Entra validation fails, try local JWT as fallback
        try {
          const payload = verifyLocalToken(token);
          req.user = payload;
          next();
        } catch {
          logger.error('Token-Validierung fehlgeschlagen', { entraError: String(entraErr), localError: 'fallback failed' });
          res.status(401).json({ error: 'Ungültiges oder abgelaufenes Token' });
        }
      });
  } else {
    // Entra ID not configured — use local JWT only
    try {
      const payload = verifyLocalToken(token);
      req.user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Ungültiges oder abgelaufenes Token' });
    }
  }
}
