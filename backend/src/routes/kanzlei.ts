import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../utils/logger';
import { invalidateKanzleiCache } from '../utils/gutachtenGenerator';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const router = Router();

function findKanzleiPath(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'gutachtenvorlagen', 'kanzlei.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), 'gutachtenvorlagen', 'kanzlei.json');
}

function findSyncScript(): string | null {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'scripts', 'update-briefkopf.py');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function runSyncScript(scriptPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('python3', [scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        logger.warn('Briefkopf-Sync fehlgeschlagen', { error: err, stderr });
        resolve('Sync-Script fehlgeschlagen');
      } else {
        const output = stdout.trim();
        logger.info('Briefkopf-Sync ausgeführt', { output });
        resolve(output);
      }
    });
  });
}

// GET / — read kanzlei.json
router.get('/', authMiddleware, (_req: Request, res: Response): void => {
  try {
    const kanzleiPath = findKanzleiPath();
    if (!fs.existsSync(kanzleiPath)) {
      res.status(404).json({ error: 'kanzlei.json nicht gefunden' });
      return;
    }
    const data = JSON.parse(fs.readFileSync(kanzleiPath, 'utf-8'));
    res.json(data);
  } catch (err) {
    logger.error('Fehler beim Lesen von kanzlei.json', { error: err });
    res.status(500).json({ error: 'Fehler beim Lesen der Kanzleidaten' });
  }
});

// PUT / — write kanzlei.json + run sync script
// TODO: add admin-only gate back later (req.user!.role !== 'admin')
router.put('/', authMiddleware, (req: Request, res: Response): void => {
  const data = req.body;
  if (!data || !data.kanzlei || !data.partner || !data.standorte) {
    res.status(400).json({ error: 'Ungültige Kanzleidaten' });
    return;
  }

  try {
    const kanzleiPath = findKanzleiPath();
    fs.writeFileSync(kanzleiPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    invalidateKanzleiCache();
    logger.info('kanzlei.json aktualisiert');
  } catch (err) {
    logger.error('Fehler beim Schreiben von kanzlei.json', { error: err });
    res.status(500).json({ error: 'Fehler beim Speichern der Kanzleidaten' });
    return;
  }

  // Run sync script to update Gutachten templates (async, non-blocking for response)
  const scriptPath = findSyncScript();
  if (scriptPath) {
    runSyncScript(scriptPath).then((syncOutput) => {
      res.json({ ok: true, syncOutput });
    }).catch((err) => {
      logger.error('Unerwarteter Fehler im Briefkopf-Sync', { error: err });
      res.json({ ok: true, syncOutput: 'Sync-Script fehlgeschlagen' });
    });
  } else {
    res.json({ ok: true, syncOutput: '' });
  }
});

export default router;
