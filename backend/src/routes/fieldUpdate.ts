import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { readResultJson, writeResultJson } from '../db/resultJson';
import { recordCorrection } from '../utils/fewShotCollector';
import type { Pruefstatus } from '../types/extraction';

const router = Router();

/**
 * Whitelist of field paths that can be updated via this endpoint.
 * These are the 9 fields required by the standard letters.
 */
const ALLOWED_FIELDS = new Set([
  'verfahrensdaten.aktenzeichen',
  'verfahrensdaten.gericht',
  'schuldner.name',
  'schuldner.vorname',
  'schuldner.geburtsdatum',
  'schuldner.aktuelle_adresse',
  'schuldner.handelsregisternummer',
  'schuldner.firma',
  'schuldner.betriebsstaette_adresse',
]);

const VALID_PRUEFSTATUS = new Set<Pruefstatus>(['bestaetigt', 'korrigiert', 'manuell']);

router.patch('/:id/fields', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const { fieldPath, wert, pruefstatus } = req.body as {
    fieldPath: string;
    wert: string | null;
    pruefstatus: Pruefstatus;
  };

  if (!fieldPath || !ALLOWED_FIELDS.has(fieldPath)) {
    res.status(400).json({ error: `Ungültiger Feldpfad: ${fieldPath}` });
    return;
  }

  if (!pruefstatus || !VALID_PRUEFSTATUS.has(pruefstatus)) {
    res.status(400).json({ error: `Ungültiger Prüfstatus: ${pruefstatus}` });
    return;
  }

  const row = db.prepare(
    'SELECT result_json FROM extractions WHERE id = ? AND user_id = ?'
  ).get(id, userId) as { result_json: string | null } | undefined;

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

  db.prepare(
    'UPDATE extractions SET result_json = ? WHERE id = ? AND user_id = ?'
  ).run(writeResultJson(result), id, userId);

  // Audit log
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'field_update', JSON.stringify({ extractionId: id, field: fieldPath, pruefstatus }), req.ip);

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
