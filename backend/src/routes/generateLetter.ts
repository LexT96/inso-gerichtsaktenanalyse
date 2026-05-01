import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth';
import { requireExtractionAccess } from '../middleware/extractionAccess';
import { getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import { generateLetterFromTemplate, type LetterVerwalterProfile, type LetterExtras } from '../utils/letterGenerator';
import { isLetterReady } from '../utils/letterChecklist';
import type { ExtractionResult } from '../types/extraction';
import { logger } from '../utils/logger';

const router = Router();

function findStandardschreibenDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben');
}

interface LetterChecklistEntry {
  typ: string;
  typAliases?: string[];
  templateDocx?: string;
  uiInputs?: Array<{ key: string; label: string; placeholder?: string }>;
}

interface ChecklistFile {
  anschreiben: LetterChecklistEntry[];
}

function loadChecklisten(): ChecklistFile {
  const p = path.join(findStandardschreibenDir(), 'checklisten.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ChecklistFile;
}

function findChecklistEntry(typ: string): LetterChecklistEntry | undefined {
  const { anschreiben } = loadChecklisten();
  return anschreiben.find(
    (c) => c.typ === typ
      || c.typ.toLowerCase() === typ.toLowerCase()
      || c.typAliases?.includes(typ),
  );
}

// verwalter_profiles schema (migration 003):
//   id, name, titel, geschlecht, diktatzeichen, sachbearbeiter_*, standort, anderkonto_*
// NO `art` column exists — the Verwalter-Art ("Insolvenzverwalter", "vorläufiger
// Insolvenzverwalter", "Sachverständiger") depends on the Bestellungsbeschluss for
// a specific case, not on the profile. Default to "Insolvenzverwalter"; caller can
// override via extras.verwalter_art (honored below when building the letter).
function loadVerwalterProfile(
  db: ReturnType<typeof getDb>,
  verwalterId: number | null,
): Omit<LetterVerwalterProfile, 'art'> | null {
  if (!verwalterId) return null;
  const row = db.prepare(
    `SELECT name, diktatzeichen, geschlecht FROM verwalter_profiles WHERE id = ?`,
  ).get(verwalterId) as
    | { name: string; diktatzeichen: string; geschlecht: string }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    diktatzeichen: row.diktatzeichen ?? '',
    geschlecht: row.geschlecht === 'weiblich' ? 'weiblich' : 'maennlich',
  };
}

// POST /:extractionId/:typ  body: { verwalterId?: number, extras?: LetterExtras }
// extras.verwalter_art overrides the default 'Insolvenzverwalter' for FELD_Verwalter_Art
router.post('/:extractionId/:typ', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const db = getDb();
  const { extractionId } = req.access!;
  const typ = decodeURIComponent(String(req.params['typ'] ?? ''));

  if (!typ) {
    res.status(400).json({ error: 'Ungültige Parameter' });
    return;
  }

  const row = db.prepare(
    `SELECT result_json, verwalter_id FROM extractions
     WHERE id = ? AND status = 'completed'`,
  ).get(extractionId) as
    | { result_json: string; verwalter_id: number | null }
    | undefined;

  if (!row?.result_json) {
    res.status(404).json({ error: 'Extraktion nicht gefunden' });
    return;
  }

  const result = readResultJson<ExtractionResult>(row.result_json);
  if (!result) {
    res.status(500).json({ error: 'Ergebnis konnte nicht gelesen werden' });
    return;
  }

  // Gate on live required-field check (matches frontend's recomputeLetterStatuses).
  // The stored status from the LLM can be stale or carry advisory fehlende_daten
  // that don't block generation.
  if (!isLetterReady(result, typ)) {
    res.status(422).json({
      error: 'Anschreiben nicht bereit — Pflichtfelder fehlen. Bitte im Tab „Anschreiben" ergänzen.',
      code: 'LETTER_NOT_READY',
    });
    return;
  }

  const entry = findChecklistEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Kein Template für Typ: ${typ}` });
    return;
  }

  const verwalterIdBody = typeof req.body?.verwalterId === 'number' ? req.body.verwalterId : null;
  const verwalterId = verwalterIdBody ?? row.verwalter_id;
  const verwalterBase = loadVerwalterProfile(db, verwalterId);
  if (!verwalterBase) {
    res.status(422).json({
      error: 'Kein Verwalter-Profil zugewiesen. Bitte im Gutachten-Assistent einen Verwalter zuweisen.',
      code: 'VERWALTER_REQUIRED',
    });
    return;
  }

  // Assemble extras + split verwalter_art out as a profile override
  // Coerce all values to strings (reject objects/arrays to prevent "[object Object]" in DOCX)
  const extras: LetterExtras = {};
  if (req.body?.extras && typeof req.body.extras === 'object') {
    for (const [k, v] of Object.entries(req.body.extras as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') extras[k] = String(v);
    }
  }
  // Default "art" is gendered per the Verwalter's Geschlecht — German legal
  // usage requires the feminine form for female Verwalterinnen.
  // Callers can override via extras.verwalter_art (e.g. "vorläufiger
  // Insolvenzverwalter", "Sachverständige").
  const defaultArt = verwalterBase.geschlecht === 'weiblich'
    ? 'Insolvenzverwalterin'
    : 'Insolvenzverwalter';
  const verwalterArt = typeof extras.verwalter_art === 'string' && extras.verwalter_art.trim()
    ? extras.verwalter_art.trim()
    : defaultArt;
  delete extras.verwalter_art;

  const verwalter: LetterVerwalterProfile = { ...verwalterBase, art: verwalterArt };

  // Validate uiInputs for letters that require them (e.g. Strafakte)
  const missingInputs = (entry.uiInputs ?? []).filter(
    (i) => !extras[i.key] || !String(extras[i.key]).trim(),
  );
  if (missingInputs.length > 0) {
    res.status(422).json({
      error: 'Pflicht-Eingaben fehlen',
      missing: missingInputs.map((i) => i.key),
    });
    return;
  }

  const templatePath = path.join(findStandardschreibenDir(), entry.templateDocx);
  if (!fs.existsSync(templatePath)) {
    res.status(404).json({ error: `Template-Datei fehlt: ${entry.templateDocx}` });
    return;
  }

  try {
    const templateBuffer = fs.readFileSync(templatePath);
    const buffer = generateLetterFromTemplate(templateBuffer, result, verwalter, extras);
    const safeName = `${typ.replace(/[^a-zA-Z0-9_-]/g, '_')}_${extractionId}.docx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generierung fehlgeschlagen';
    logger.error('Letter generation failed', { extractionId, typ, error: msg });
    res.status(500).json({ error: msg });
  }
});

export default router;
