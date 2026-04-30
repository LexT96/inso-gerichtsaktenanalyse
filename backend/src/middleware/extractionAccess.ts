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
          // Audit failure must not break the response.
          // eslint-disable-next-line no-console
          console.error('audit insert failed', err);
        }
      });
    }

    next();
  };
}
