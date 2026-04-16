import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getDb } from '../db/database';
import { logger } from '../utils/logger';

const router = Router();

const ALLOWED_FIELDS = ['name', 'email', 'durchwahl'] as const;

type SachbearbeiterProfile = {
  id: number;
  name: string;
  email: string;
  durchwahl: string;
  created_at: string;
  updated_at: string;
};

// GET / — list all
router.get('/', authMiddleware, (_req: Request, res: Response): void => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sachbearbeiter_profiles ORDER BY name').all() as SachbearbeiterProfile[];
  res.json(rows);
});

// POST / — create
router.post('/', authMiddleware, (req: Request, res: Response): void => {
  const body = req.body as Partial<Record<string, string>>;

  if (!body.name || body.name.trim() === '') {
    res.status(400).json({ error: 'Name ist erforderlich' });
    return;
  }

  const db = getDb();
  const result = db.prepare(
    'INSERT INTO sachbearbeiter_profiles (name, email, durchwahl) VALUES (?, ?, ?)'
  ).run(body.name.trim(), body.email?.trim() ?? '', body.durchwahl?.trim() ?? '');

  const profile = db.prepare('SELECT * FROM sachbearbeiter_profiles WHERE id = ?')
    .get(result.lastInsertRowid) as SachbearbeiterProfile;

  logger.info('Sachbearbeiter-Profil erstellt', { id: profile.id, name: profile.name });
  res.status(201).json(profile);
});

// PUT /:id — update
router.put('/:id', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const id = parseInt(Array.isArray(req.params['id']) ? req.params['id'][0] : req.params['id'] ?? '', 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const existing = db.prepare('SELECT id FROM sachbearbeiter_profiles WHERE id = ?').get(id);
  if (!existing) { res.status(404).json({ error: 'Profil nicht gefunden' }); return; }

  const body = req.body as Partial<Record<string, string>>;
  if (body.name !== undefined && body.name.trim() === '') {
    res.status(400).json({ error: 'Name darf nicht leer sein' }); return;
  }

  const updates: string[] = [];
  const values: string[] = [];
  for (const field of ALLOWED_FIELDS) {
    if (field in body && body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(body[field]!.trim());
    }
  }
  if (updates.length === 0) { res.status(400).json({ error: 'Keine Felder zum Aktualisieren' }); return; }

  updates.push("updated_at = datetime('now')");
  values.push(String(id));
  db.prepare(`UPDATE sachbearbeiter_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM sachbearbeiter_profiles WHERE id = ?').get(id) as SachbearbeiterProfile;
  logger.info('Sachbearbeiter-Profil aktualisiert', { id });
  res.json(updated);
});

// DELETE /:id
router.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  const db = getDb();
  const id = parseInt(Array.isArray(req.params['id']) ? req.params['id'][0] : req.params['id'] ?? '', 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const existing = db.prepare('SELECT id, name FROM sachbearbeiter_profiles WHERE id = ?').get(id) as { id: number; name: string } | undefined;
  if (!existing) { res.status(404).json({ error: 'Profil nicht gefunden' }); return; }

  db.prepare('DELETE FROM sachbearbeiter_profiles WHERE id = ?').run(id);
  logger.info('Sachbearbeiter-Profil gelöscht', { id, name: existing.name });
  res.status(204).send();
});

export default router;
