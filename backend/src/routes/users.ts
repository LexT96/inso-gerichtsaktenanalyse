import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';

const router = Router();

// GET /share-candidates — active users excluding the current one
router.get('/share-candidates', authMiddleware, (req: Request, res: Response): void => {
  const rows = getDb().prepare(
    `SELECT id AS userId, username, display_name AS displayName
     FROM users
     WHERE active = 1 AND id != ?
     ORDER BY display_name`
  ).all(req.user!.userId);
  res.json(rows);
});

export default router;
