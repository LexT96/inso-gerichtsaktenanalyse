import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const router = Router();

const ALLOWED_FIELDS = [
  'name',
  'titel',
  'geschlecht',
  'diktatzeichen',
  'standort',
  'anderkonto_iban',
  'anderkonto_bank',
] as const;

type VerwalterProfile = {
  id: number;
  name: string;
  titel: string;
  geschlecht: string;
  diktatzeichen: string;
  standort: string;
  anderkonto_iban: string;
  anderkonto_bank: string;
  created_at: string;
  updated_at: string;
};

// GET / — list all profiles
router.get('/', authMiddleware, (_req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM verwalter_profiles ORDER BY name'
  ).all() as VerwalterProfile[];
  res.json(rows);
});

// POST / — create new profile
router.post('/', authMiddleware, (req: Request, res: Response): void => {
  const body = req.body as Partial<Record<typeof ALLOWED_FIELDS[number], string>>;

  if (!body.name || body.name.trim() === '') {
    res.status(400).json({ error: 'Name ist erforderlich' });
    return;
  }

  if (body.geschlecht && body.geschlecht !== 'maennlich' && body.geschlecht !== 'weiblich') {
    res.status(400).json({ error: 'Geschlecht muss "maennlich" oder "weiblich" sein' });
    return;
  }

  const db = getDb();
  const result = db.prepare(
    `INSERT INTO verwalter_profiles
      (name, titel, geschlecht, diktatzeichen, standort,
       anderkonto_iban, anderkonto_bank)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    body.name.trim(),
    body.titel?.trim() ?? '',
    body.geschlecht ?? 'maennlich',
    body.diktatzeichen?.trim() ?? '',
    body.standort?.trim() ?? '',
    body.anderkonto_iban?.trim() ?? '',
    body.anderkonto_bank?.trim() ?? '',
  );

  const newProfile = db.prepare(
    'SELECT * FROM verwalter_profiles WHERE id = ?'
  ).get(result.lastInsertRowid) as VerwalterProfile;

  logger.info('Verwalter-Profil erstellt', { id: newProfile.id, name: newProfile.name });
  res.status(201).json(newProfile);
});

// PUT /:id — partial update
router.put('/:id', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const existing = db.prepare(
    'SELECT id FROM verwalter_profiles WHERE id = ?'
  ).get(id) as { id: number } | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Verwalter-Profil nicht gefunden' });
    return;
  }

  const body = req.body as Partial<Record<string, string>>;

  if (body.geschlecht !== undefined && body.geschlecht !== 'maennlich' && body.geschlecht !== 'weiblich') {
    res.status(400).json({ error: 'Geschlecht muss "maennlich" oder "weiblich" sein' });
    return;
  }

  if (body.name !== undefined && body.name.trim() === '') {
    res.status(400).json({ error: 'Name darf nicht leer sein' });
    return;
  }

  // Build dynamic SET clause from only allowed fields present in body
  const updates: string[] = [];
  const values: string[] = [];

  for (const field of ALLOWED_FIELDS) {
    if (field in body && body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(field === 'name' ? (body[field] as string).trim() : (body[field] as string));
    }
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'Keine gültigen Felder zum Aktualisieren angegeben' });
    return;
  }

  updates.push("updated_at = datetime('now')");
  values.push(String(id));

  db.prepare(
    `UPDATE verwalter_profiles SET ${updates.join(', ')} WHERE id = ?`
  ).run(...values);

  const updated = db.prepare(
    'SELECT * FROM verwalter_profiles WHERE id = ?'
  ).get(id) as VerwalterProfile;

  logger.info('Verwalter-Profil aktualisiert', { id, fields: Object.keys(body).filter(k => ALLOWED_FIELDS.includes(k as typeof ALLOWED_FIELDS[number])) });
  res.json(updated);
});

// DELETE /:id — delete profile
router.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const idParam = req.params['id'];
  const id = parseInt(Array.isArray(idParam) ? idParam[0] : idParam ?? '', 10);

  if (isNaN(id)) {
    res.status(400).json({ error: 'Ungültige ID' });
    return;
  }

  const existing = db.prepare(
    'SELECT id, name FROM verwalter_profiles WHERE id = ?'
  ).get(id) as { id: number; name: string } | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Verwalter-Profil nicht gefunden' });
    return;
  }

  db.prepare('DELETE FROM verwalter_profiles WHERE id = ?').run(id);

  logger.info('Verwalter-Profil gelöscht', { id, name: existing.name });
  res.status(204).send();
});

export default router;
