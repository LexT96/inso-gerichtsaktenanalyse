import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import { generateDocx } from '../utils/docxGenerator';
import type { ExtractionResult } from '../types/extraction';

const router = Router();

router.post('/:extractionId/:typ', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const userId = req.user!.userId;
  const extractionId = parseInt(String(req.params['extractionId'] ?? ''), 10);
  const typ = decodeURIComponent(String(req.params['typ'] ?? ''));

  if (isNaN(extractionId) || !typ) {
    res.status(400).json({ error: 'Ungültige Parameter' });
    return;
  }

  const row = db.prepare(
    `SELECT result_json FROM extractions WHERE id = ? AND user_id = ? AND status = 'completed'`
  ).get(extractionId, userId) as { result_json: string } | undefined;

  if (!row?.result_json) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  const result = readResultJson<ExtractionResult>(row.result_json)!;

  const letter = result.standardanschreiben?.find(
    l => l.typ === typ || l.typ?.toLowerCase() === typ.toLowerCase()
  );

  if (!letter) {
    res.status(404).json({ error: `Anschreiben-Typ nicht gefunden: ${typ}` });
    return;
  }

  if (letter.status !== 'bereit') {
    res.status(422).json({ error: `Anschreiben nicht bereit (Status: ${letter.status})` });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const checklisten = JSON.parse(
    require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'standardschreiben/checklisten.json'),
      'utf-8'
    )
  ) as {
    anschreiben: Array<{ typ: string; templatePdf?: string; typAliases?: string[] }>;
  };

  const checkItem = checklisten.anschreiben.find(
    (c: { typ: string; typAliases?: string[] }) => c.typ === typ || c.typAliases?.includes(typ)
  );

  if (!checkItem?.templatePdf) {
    res.status(404).json({ error: `Kein Template für Typ: ${typ}` });
    return;
  }

  const templateDocx = checkItem.templatePdf.replace(/\.pdf$/i, '.docx');

  try {
    const buffer = generateDocx(templateDocx, result);
    const safeName = `${typ.replace(/[^a-zA-Z0-9_-]/g, '_')}_${extractionId}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generierung fehlgeschlagen';
    res.status(500).json({ error: msg });
  }
});

export default router;
