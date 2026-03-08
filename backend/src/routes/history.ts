import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import type { HistoryItem, ExtractionResponse } from '../types/api';

const router = Router();

router.get('/', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;

  const rows = db.prepare(
    `SELECT id, filename, file_size, status, stats_found, stats_missing,
            stats_letters_ready, processing_time_ms, created_at
     FROM extractions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
  ).all(userId) as Array<{
    id: number; filename: string; file_size: number; status: string;
    stats_found: number; stats_missing: number; stats_letters_ready: number;
    processing_time_ms: number | null; created_at: string;
  }>;

  const items: HistoryItem[] = rows.map(row => ({
    id: row.id,
    filename: row.filename,
    fileSize: row.file_size,
    status: row.status as HistoryItem['status'],
    statsFound: row.stats_found,
    statsMissing: row.stats_missing,
    statsLettersReady: row.stats_letters_ready,
    processingTimeMs: row.processing_time_ms,
    createdAt: row.created_at,
  }));

  res.json(items);
});

router.get('/:id', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const row = db.prepare(
    `SELECT id, filename, file_size, result_json, status, error_message,
            stats_found, stats_missing, stats_letters_ready, processing_time_ms, created_at
     FROM extractions WHERE id = ? AND user_id = ?`
  ).get(id, userId) as {
    id: number; filename: string; file_size: number; result_json: string | null;
    status: string; error_message: string | null;
    stats_found: number; stats_missing: number; stats_letters_ready: number;
    processing_time_ms: number | null; created_at: string;
  } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  const response: ExtractionResponse = {
    id: row.id,
    filename: row.filename,
    status: row.status as ExtractionResponse['status'],
    result: row.result_json ? JSON.parse(row.result_json) : null,
    statsFound: row.stats_found,
    statsMissing: row.stats_missing,
    statsLettersReady: row.stats_letters_ready,
    processingTimeMs: row.processing_time_ms,
    createdAt: row.created_at,
  };

  res.json(response);
});

export default router;
