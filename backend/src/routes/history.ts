import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { config } from '../config';
import { readResultJson } from '../db/resultJson';
import { encrypt, decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';
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

  // Return 410 Gone for expired/deleted extractions
  if (!row.result_json && (row.status === 'expired' || row.status === 'deleted_art17')) {
    const message = row.status === 'expired'
      ? 'Extraktion abgelaufen — bitte .iae-Datei importieren'
      : 'Extraktion gelöscht (Art. 17 DSGVO)';
    res.status(410).json({ error: message, status: row.status });
    return;
  }

  const response: ExtractionResponse = {
    id: row.id,
    filename: row.filename,
    status: row.status as ExtractionResponse['status'],
    result: readResultJson(row.result_json),
    statsFound: row.stats_found,
    statsMissing: row.stats_missing,
    statsLettersReady: row.stats_letters_ready,
    processingTimeMs: row.processing_time_ms,
    createdAt: row.created_at,
  };

  res.json(response);
});

// Serve stored PDF for extraction
router.get('/:id/pdf', authMiddleware, (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  // Verify user owns this extraction
  const db = getDb();
  const row = db.prepare(
    'SELECT id, filename FROM extractions WHERE id = ? AND user_id = ?'
  ).get(id, userId) as { id: number; filename: string } | undefined;
  if (!row) { res.status(404).json({ error: 'Nicht gefunden' }); return; }

  const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
  const pdfPath = path.join(pdfDir, `${id}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    res.status(404).json({ error: 'PDF nicht mehr verfügbar' });
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.filename)}"`);
  fs.createReadStream(pdfPath).pipe(res);
});

// Export encrypted extraction result
router.post('/:id/export', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password || password.length < 8) {
    res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen lang sein' });
    return;
  }

  const row = db.prepare(
    `SELECT id, filename, result_json, status, stats_found, stats_missing, stats_letters_ready, created_at
     FROM extractions WHERE id = ? AND user_id = ?`
  ).get(id, userId) as {
    id: number; filename: string; result_json: string | null; status: string;
    stats_found: number; stats_missing: number; stats_letters_ready: number;
    created_at: string;
  } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  if (!row.result_json) {
    res.status(410).json({ error: 'Extraktionsdaten nicht mehr verfügbar' });
    return;
  }

  const decryptedJson = JSON.stringify(readResultJson(row.result_json));
  const encrypted = encrypt(decryptedJson, password);

  const exportData = {
    version: 1,
    format: 'insolvenz-akte-export',
    encrypted: true,
    salt: encrypted.salt,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    data: encrypted.data,
    metadata: {
      filename: row.filename,
      exportedAt: new Date().toISOString(),
      statsFound: row.stats_found,
      statsMissing: row.stats_missing,
    },
  };

  // Audit log
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'export', JSON.stringify({ extractionId: id, filename: row.filename }), req.ip);

  logger.info('Extraktion exportiert', { extractionId: id, userId });

  const sanitizedName = row.filename.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9äöüÄÖÜß_\-. ]/g, '_');
  const exportFilename = sanitizedName + '.iae';
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportFilename)}`);
  res.setHeader('Content-Type', 'application/json');
  res.json(exportData);
});

// Import encrypted extraction result
router.post('/import', authMiddleware, (req: Request, res: Response): void => {
  const userId = req.user!.userId;

  const { exportData, password } = req.body as {
    exportData?: {
      version?: number;
      format?: string;
      encrypted?: boolean;
      salt?: string;
      iv?: string;
      authTag?: string;
      data?: string;
      metadata?: { filename?: string; exportedAt?: string; statsFound?: number; statsMissing?: number };
    };
    password?: string;
  };

  if (!exportData || !password) {
    res.status(400).json({ error: 'Export-Daten und Passwort erforderlich' });
    return;
  }

  if (exportData.format !== 'insolvenz-akte-export' || exportData.version !== 1) {
    res.status(400).json({ error: 'Ungültiges Dateiformat' });
    return;
  }

  if (!exportData.salt || !exportData.iv || !exportData.authTag || !exportData.data) {
    res.status(400).json({ error: 'Unvollständige Export-Daten' });
    return;
  }

  try {
    const decryptedJson = decrypt(
      { salt: exportData.salt, iv: exportData.iv, authTag: exportData.authTag, data: exportData.data },
      password
    );

    const rawResult = JSON.parse(decryptedJson);

    // Validate imported data against schema (prevents deserialization attacks)
    const { extractionResultSchema } = require('../utils/validation');
    const parseResult = extractionResultSchema.safeParse(rawResult);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Importierte Daten sind ungültig oder beschädigt.' });
      return;
    }
    const result = parseResult.data;

    // Audit log
    const db = getDb();
    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(userId, 'import', JSON.stringify({ filename: exportData.metadata?.filename }), req.ip);

    logger.info('Extraktion importiert', { userId, filename: exportData.metadata?.filename });

    // Return decrypted result WITHOUT persisting to database
    res.json({
      result,
      metadata: exportData.metadata,
    });
  } catch {
    res.status(400).json({ error: 'Entschlüsselung fehlgeschlagen — falsches Passwort?' });
  }
});

// Delete extraction data (DSGVO Art. 17)
router.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const row = db.prepare(
    'SELECT id, filename FROM extractions WHERE id = ? AND user_id = ?'
  ).get(id, userId) as { id: number; filename: string } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  db.prepare(
    `UPDATE extractions SET result_json = NULL, status = 'deleted_art17' WHERE id = ?`
  ).run(id);

  // Audit log
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'deletion_art17', JSON.stringify({ extractionId: id, filename: row.filename }), req.ip);

  logger.info('Extraktion gelöscht (Art. 17 DSGVO)', { extractionId: id, userId });

  res.status(204).send();
});

export default router;
