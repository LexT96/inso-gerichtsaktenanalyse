import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireExtractionAccess } from '../middleware/extractionAccess';
import { getDb } from '../db/database';
import { readResultJson, writeResultJson } from '../db/resultJson';
import { recordCorrection } from '../utils/fewShotCollector';
import { computeExtractionStats } from '../utils/computeStats';
import type { Pruefstatus, ExtractionResult } from '../types/extraction';

const router = Router();

/**
 * Any SourcedValue field path is allowed for editing.
 * Validation: path must resolve to an object with 'wert' key in the result.
 * All corrections feed into the few-shot learning loop.
 */

const VALID_PRUEFSTATUS = new Set<Pruefstatus>(['bestaetigt', 'korrigiert', 'manuell']);

router.patch('/:id/fields', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const { extractionId } = req.access!;
  const db = getDb();
  const userId = req.user!.userId;

  const { fieldPath, wert, pruefstatus } = req.body as {
    fieldPath: string;
    wert: string | null;
    pruefstatus: Pruefstatus;
  };

  if (!fieldPath || typeof fieldPath !== 'string' || fieldPath.length > 200) {
    res.status(400).json({ error: 'Ungültiger Feldpfad' });
    return;
  }

  if (!pruefstatus || !VALID_PRUEFSTATUS.has(pruefstatus)) {
    res.status(400).json({ error: `Ungültiger Prüfstatus: ${pruefstatus}` });
    return;
  }

  const row = db.prepare(
    'SELECT result_json FROM extractions WHERE id = ?'
  ).get(extractionId) as { result_json: string | null } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  if (!row.result_json) {
    res.status(400).json({ error: 'Extraktion hat kein Ergebnis' });
    return;
  }

  const result = readResultJson<Record<string, unknown>>(row.result_json);
  const parts = fieldPath.split('.');

  let obj: Record<string, unknown> = result as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    obj = obj[parts[i]] as Record<string, unknown>;
    if (!obj) {
      res.status(400).json({ error: `Pfad nicht gefunden: ${fieldPath}` });
      return;
    }
  }

  const leafKey = parts[parts.length - 1];
  const field = obj[leafKey] as Record<string, unknown> | undefined;

  if (!field || typeof field !== 'object') {
    res.status(400).json({ error: `Feld nicht gefunden: ${fieldPath}` });
    return;
  }

  // Record correction for few-shot learning before overwriting
  const originalValue = field.wert != null ? String(field.wert) : null;
  recordCorrection(fieldPath, originalValue, wert, pruefstatus);

  field.wert = wert;
  field.pruefstatus = pruefstatus;

  // Recompute stats so history dashboard stays in sync with the live view
  const stats = computeExtractionStats(result as unknown as ExtractionResult);
  db.prepare(
    'UPDATE extractions SET result_json = ?, stats_found = ?, stats_missing = ?, stats_letters_ready = ? WHERE id = ?'
  ).run(writeResultJson(result), stats.found, stats.missing, stats.lettersReady, extractionId);

  // Audit log
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'field_update', JSON.stringify({ extractionId, field: fieldPath, pruefstatus }), req.ip);

  res.json({
    ok: true,
    field: {
      wert: field.wert,
      quelle: field.quelle,
      verifiziert: field.verifiziert,
      pruefstatus: field.pruefstatus,
    },
  });
});

export default router;
