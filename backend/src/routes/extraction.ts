import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { uploadMiddleware } from '../middleware/upload';
import { extractionRateLimit } from '../middleware/rateLimit';
import { processExtraction } from '../services/extraction';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

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
  async (req: Request, res: Response): Promise<void> => {
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

    // Stream progress via SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    const sendProgress = (message: string, percent: number) => {
      res.write(`data: ${JSON.stringify({ type: 'progress', message, percent })}\n\n`);
    };

    try {
      sendProgress('PDF empfangen — Verarbeitung startet…', 5);

      const { id, result, stats, processingTimeMs } = await processExtraction(
        req.file.buffer,
        req.file.originalname,
        req.file.size,
        userId,
        sendProgress
      );

      // Audit log: extraction completed
      db.prepare(
        'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
      ).run(
        userId,
        'extraction_completed',
        JSON.stringify({ extractionId: id, filename: req.file.originalname, found: stats.found, missing: stats.missing, processingTimeMs }),
        req.ip
      );

      res.write(`data: ${JSON.stringify({
        type: 'result',
        id,
        filename: req.file.originalname,
        status: 'completed',
        result,
        statsFound: stats.found,
        statsMissing: stats.missing,
        statsLettersReady: stats.lettersReady,
        processingTimeMs,
        createdAt: new Date().toISOString(),
      })}\n\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Extraktion fehlgeschlagen (SSE)', { error: message });
      res.write(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`);
    }

    res.end();
  }
);

export default router;
