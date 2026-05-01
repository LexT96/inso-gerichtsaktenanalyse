import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireExtractionAccess } from '../middleware/extractionAccess';
import { heavyOperationRateLimit } from '../middleware/rateLimit';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const router = Router({ mergeParams: true });

// GET /:id/shares — list (owner+admin only)
router.get(
  '/:id/shares',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const rows = getDb().prepare(
      `SELECT s.user_id AS userId, u.display_name AS displayName, u.username AS username,
              s.granted_by AS grantedBy, s.granted_at AS grantedAt
       FROM extraction_shares s
       JOIN users u ON u.id = s.user_id
       WHERE s.extraction_id = ?
       ORDER BY s.granted_at DESC`
    ).all(extractionId);
    res.json(rows);
  }
);

// POST /:id/shares — grant (owner+admin only)
router.post(
  '/:id/shares',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  heavyOperationRateLimit,
  (req: Request, res: Response): void => {
    const { extractionId, ownerId } = req.access!;
    const body = req.body as { userId?: number };
    const recipientId = Number(body.userId);
    if (!Number.isFinite(recipientId)) { res.status(400).json({ error: 'userId fehlt' }); return; }

    if (recipientId === ownerId) {
      res.status(400).json({ error: 'Akte kann nicht mit dem Eigentümer geteilt werden' });
      return;
    }

    const recipient = getDb().prepare(
      'SELECT id, username, display_name, active FROM users WHERE id = ?'
    ).get(recipientId) as { id: number; username: string; display_name: string; active: number } | undefined;
    if (!recipient || recipient.active !== 1) {
      res.status(404).json({ error: 'Empfänger nicht gefunden oder deaktiviert' });
      return;
    }

    try {
      const result = getDb().prepare(
        'INSERT INTO extraction_shares (extraction_id, user_id, granted_by) VALUES (?, ?, ?)'
      ).run(extractionId, recipientId, req.user!.userId);

      const row = getDb().prepare(
        'SELECT user_id AS userId, granted_at AS grantedAt FROM extraction_shares WHERE id = ?'
      ).get(result.lastInsertRowid) as { userId: number; grantedAt: string };

      getDb().prepare(
        'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
      ).run(
        req.user!.userId,
        'share_granted',
        JSON.stringify({ extractionId, recipientUserId: recipientId, recipientName: recipient.display_name }),
        req.ip ?? null
      );

      logger.info('Akte geteilt', { extractionId, recipientUserId: recipientId, grantedBy: req.user!.userId });
      res.status(201).json({ ...row, displayName: recipient.display_name, username: recipient.username });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: `${recipient.display_name} hat bereits Zugriff` });
        return;
      }
      throw err;
    }
  }
);

// DELETE /:id/shares/:userId — revoke (owner+admin only)
router.delete(
  '/:id/shares/:userId',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  heavyOperationRateLimit,
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const recipientId = parseInt(String(req.params['userId']), 10);
    if (!Number.isFinite(recipientId)) { res.status(400).json({ error: 'Ungültige userId' }); return; }

    const existing = getDb().prepare(
      `SELECT s.user_id AS userId, u.display_name AS displayName
       FROM extraction_shares s JOIN users u ON u.id = s.user_id
       WHERE s.extraction_id = ? AND s.user_id = ?`
    ).get(extractionId, recipientId) as { userId: number; displayName: string } | undefined;
    if (!existing) { res.status(404).json({ error: 'Kein Share gefunden' }); return; }

    getDb().prepare(
      'DELETE FROM extraction_shares WHERE extraction_id = ? AND user_id = ?'
    ).run(extractionId, recipientId);

    getDb().prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(
      req.user!.userId,
      'share_revoked',
      JSON.stringify({ extractionId, recipientUserId: recipientId, recipientName: existing.displayName }),
      req.ip ?? null
    );

    logger.info('Share entzogen', { extractionId, recipientUserId: recipientId, revokedBy: req.user!.userId });
    res.status(204).send();
  }
);

// GET /:id/access-log — chronological audit entries (owner+admin only)
router.get(
  '/:id/access-log',
  authMiddleware,
  requireExtractionAccess({ ownerOnly: true, skipAudit: true }),
  (req: Request, res: Response): void => {
    const { extractionId } = req.access!;
    const rows = getDb().prepare(
      `SELECT a.id, a.user_id AS userId, u.display_name AS actorName,
              a.action, a.details, a.created_at AS createdAt
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.action IN ('share_read','share_edit','share_granted','share_revoked')
         AND json_extract(a.details, '$.extractionId') = ?
       ORDER BY a.id DESC LIMIT 200`
    ).all(extractionId);
    res.json(rows);
  }
);

export default router;
