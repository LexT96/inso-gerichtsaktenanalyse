import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { heavyOperationRateLimit } from '../middleware/rateLimit';
import { getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import {
  prepareGutachten,
  generateGutachtenFinal,
  type GutachtenUserInputs,
} from '../utils/gutachtenGenerator';
import type { ExtractionResult } from '../types/extraction';

const router = Router();

function parseUserInputs(body: Record<string, unknown>): GutachtenUserInputs | null {
  const { verwalter_diktatzeichen, verwalter_geschlecht } = body;
  if (!verwalter_diktatzeichen || typeof verwalter_diktatzeichen !== 'string') return null;
  if (verwalter_geschlecht !== 'maennlich' && verwalter_geschlecht !== 'weiblich') return null;

  return {
    verwalter_diktatzeichen: String(verwalter_diktatzeichen),
    verwalter_geschlecht: verwalter_geschlecht as 'maennlich' | 'weiblich',
    anderkonto_iban: body.anderkonto_iban ? String(body.anderkonto_iban) : undefined,
    anderkonto_bank: body.anderkonto_bank ? String(body.anderkonto_bank) : undefined,
    geschaeftsfuehrer: body.geschaeftsfuehrer ? String(body.geschaeftsfuehrer) : undefined,
    last_gavv: body.last_gavv ? String(body.last_gavv) : undefined,
  };
}

function loadExtraction(extractionId: number, userId: number): ExtractionResult | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT result_json FROM extractions WHERE id = ? AND user_id = ? AND status = 'completed'`
  ).get(extractionId, userId) as { result_json: string } | undefined;
  if (!row?.result_json) return null;
  return readResultJson<ExtractionResult>(row.result_json)!;
}

// POST /:extractionId/prepare — extract slots, fill via Claude, return JSON
router.post('/:extractionId/prepare', authMiddleware, heavyOperationRateLimit, async (req: Request, res: Response): Promise<void> => {
  try {
    const extractionId = parseInt(String(req.params['extractionId'] ?? ''), 10);
    if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige Extraktions-ID' }); return; }

    const userInputs = parseUserInputs(req.body);
    if (!userInputs) { res.status(400).json({ error: 'verwalter_diktatzeichen und verwalter_geschlecht sind erforderlich' }); return; }

    const result = loadExtraction(extractionId, req.user!.userId);
    if (!result) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    const prepared = await prepareGutachten(result, userInputs);
    res.json(prepared);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Vorbereitung fehlgeschlagen';
    res.status(500).json({ error: msg });
  }
});

// POST /:extractionId/generate — apply slot values, return DOCX
router.post('/:extractionId/generate', authMiddleware, (req: Request, res: Response): void => {
  try {
    const extractionId = parseInt(String(req.params['extractionId'] ?? ''), 10);
    if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige Extraktions-ID' }); return; }

    const { userInputs: rawInputs, slots } = req.body as { userInputs?: Record<string, unknown>; slots?: { id: string; value: string }[] };

    const userInputs = rawInputs ? parseUserInputs(rawInputs) : null;
    if (!userInputs) { res.status(400).json({ error: 'userInputs mit verwalter_diktatzeichen und verwalter_geschlecht erforderlich' }); return; }
    if (!Array.isArray(slots)) { res.status(400).json({ error: 'slots Array erforderlich' }); return; }

    const result = loadExtraction(extractionId, req.user!.userId);
    if (!result) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

    const buffer = generateGutachtenFinal(result, userInputs, slots);
    const safeName = `Gutachten_${extractionId}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gutachten-Generierung fehlgeschlagen';
    res.status(500).json({ error: msg });
  }
});

export default router;
