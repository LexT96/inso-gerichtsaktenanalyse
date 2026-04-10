import { Request, Response, NextFunction } from 'express';
import { authMiddleware } from './auth';

/**
 * Admin-only middleware. Runs authMiddleware first, then checks role === 'admin'.
 * Returns 403 if the authenticated user is not an admin.
 */
export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  authMiddleware(req, res, (err?: unknown) => {
    if (err) return next(err);
    // authMiddleware may have already sent a response (401/403)
    if (res.headersSent) return;
    if (!req.user || req.user.role !== 'admin') {
      res.status(403).json({ error: 'Nur Administratoren haben Zugriff.' });
      return;
    }
    next();
  });
}
