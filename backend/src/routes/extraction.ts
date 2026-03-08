import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { uploadMiddleware } from '../middleware/upload';
import { extractionRateLimit } from '../middleware/rateLimit';
import { processExtraction } from '../services/extraction';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';
import type { ExtractionResponse } from '../types/api';

const router = Router();

router.post(
  '/',
  authMiddleware,
  extractionRateLimit,
  (req: Request, res: Response, next: NextFunction) => {
    uploadMiddleware(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Keine PDF-Datei hochgeladen' });
        return;
      }

      const userId = req.user!.userId;

      // Audit log
      const db = getDb();
      db.prepare(
        'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
      ).run(
        userId,
        'extraction',
        JSON.stringify({ filename: req.file.originalname, fileSize: req.file.size }),
        req.ip
      );

      const { id, result, stats, processingTimeMs } = await processExtraction(
        req.file.path,
        req.file.originalname,
        req.file.size,
        userId
      );

      const response: ExtractionResponse = {
        id,
        filename: req.file.originalname,
        status: 'completed',
        result,
        statsFound: stats.found,
        statsMissing: stats.missing,
        statsLettersReady: stats.lettersReady,
        processingTimeMs,
        createdAt: new Date().toISOString(),
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
