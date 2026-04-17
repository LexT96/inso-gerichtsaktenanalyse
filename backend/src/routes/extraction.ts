import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { uploadMiddleware, validatePdfBuffer } from '../middleware/upload';
import { extractionRateLimit } from '../middleware/rateLimit';
import { processExtraction } from '../services/extraction';
import { config } from '../config';
import { getDb } from '../db/database';
import { writeResultJson } from '../db/resultJson';
import { computeExtractionStats } from '../utils/computeStats';
import { getRateLimiterStatus } from '../services/rateLimiter';
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

    // Validate PDF magic bytes (prevents MIME spoofing)
    try {
      validatePdfBuffer(req.file.buffer);
    } catch {
      res.status(400).json({ error: 'Datei ist kein gültiges PDF.' });
      return;
    }

    // Reject if another extraction is already running (Langdock 60K TPM can't handle concurrent extractions)
    const rlStatus = getRateLimiterStatus();
    if (rlStatus.activeExtractions > 0) {
      res.status(429).json({
        error: 'Eine andere Extraktion läuft bereits. Bitte warten Sie, bis diese abgeschlossen ist, und versuchen Sie es erneut.',
      });
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

      // Pro mode: use Opus for higher accuracy (user-selectable)
      const proMode = req.query.pro === '1' || req.query.pro === 'true';
      // Langdock requires -default suffix on model names
      const opusModel = config.ANTHROPIC_BASE_URL?.includes('langdock') ? 'claude-opus-4-6-default' : 'claude-opus-4-6';
      const modelOverride = proMode ? opusModel : undefined;

      const { id, result, stats, processingTimeMs } = await processExtraction(
        req.file.buffer,
        req.file.originalname,
        req.file.size,
        userId,
        sendProgress,
        modelOverride
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
      const internalMsg = error instanceof Error ? error.message : String(error);
      logger.error('Extraktion fehlgeschlagen (SSE)', { error: internalMsg });
      // Never expose internal error details to client (BRAO compliance)
      const clientMsg = internalMsg.includes('Rate') || internalMsg.includes('429')
        ? 'API-Ratenlimit erreicht. Bitte versuchen Sie es in einer Minute erneut.'
        : 'Extraktion fehlgeschlagen. Bitte versuchen Sie es erneut.';
      res.write(`data: ${JSON.stringify({ type: 'error', error: clientMsg })}\n\n`);
    }

    res.end();
  }
);

// Persist demo extraction so Gutachten generation works without running the pipeline
router.post('/demo', authMiddleware, (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const { result } = req.body as { result?: unknown };

  if (!result || typeof result !== 'object') {
    res.status(400).json({ error: 'result erforderlich' });
    return;
  }

  const db = getDb();

  // Reuse existing demo extraction if one exists for this user (revive expired rows)
  const existing = db.prepare(
    "SELECT id FROM extractions WHERE user_id = ? AND filename = 'demo-test.pdf' ORDER BY id DESC LIMIT 1"
  ).get(userId) as { id: number } | undefined;

  if (existing) {
    db.prepare("UPDATE extractions SET result_json = ?, status = 'completed' WHERE id = ?")
      .run(writeResultJson(result), existing.id);
    res.json({ id: existing.id });
    return;
  }

  const stats = computeExtractionStats(result as import('../types/extraction').ExtractionResult);

  const insertResult = db.prepare(
    `INSERT INTO extractions (user_id, filename, file_size, status, result_json, stats_found, stats_missing, stats_letters_ready, processing_time_ms)
     VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, 0)`
  ).run(userId, 'demo-test.pdf', 0, writeResultJson(result), stats.found, stats.missing, stats.lettersReady);

  res.json({ id: Number(insertResult.lastInsertRowid) });
});

export default router;
