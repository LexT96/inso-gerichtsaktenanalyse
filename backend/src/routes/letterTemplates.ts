import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import PizZip from 'pizzip';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../utils/logger';
import { invalidateLetterMappingCache } from '../utils/letterGenerator';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('template');

function findStandardschreibenDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben');
}

interface LetterChecklistEntry {
  typ: string;
  templateDocx?: string;
}
interface ChecklistFile { anschreiben: LetterChecklistEntry[]; }

function loadChecklisten(): ChecklistFile {
  return JSON.parse(
    fs.readFileSync(path.join(findStandardschreibenDir(), 'checklisten.json'), 'utf-8'),
  ) as ChecklistFile;
}

function findEntry(typ: string): LetterChecklistEntry | undefined {
  return loadChecklisten().anschreiben.find((e) => e.typ === typ);
}

// Extract full DOCX text (all <w:t> joined) — survives Word run-splitting
function extractDocxText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const docXml = zip.file('word/document.xml');
  if (!docXml) throw new Error('word/document.xml nicht gefunden — keine gültige DOCX-Datei.');
  const xml = docXml.asText();
  const texts: string[] = [];
  for (const m of xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) texts.push(m[1]);
  return texts.join('');
}

// Required placeholders per letter type: derived from current on-disk template
function getRequiredPlaceholders(typ: string): string[] {
  const entry = findEntry(typ);
  if (!entry?.templateDocx) return [];
  const p = path.join(findStandardschreibenDir(), entry.templateDocx);
  if (!fs.existsSync(p)) return [];
  const text = extractDocxText(fs.readFileSync(p));
  const tokens = new Set<string>();
  for (const m of text.matchAll(/FELD_[A-Za-zÄÖÜäöüß0-9]+(?:_[A-Za-zÄÖÜäöüß0-9]+)*/g)) {
    tokens.add(m[0]);
  }
  return [...tokens];
}

// GET / — list all letter templates
router.get('/', authMiddleware, (_req: Request, res: Response): void => {
  try {
    const dir = findStandardschreibenDir();
    const entries = loadChecklisten().anschreiben;
    const list = entries.map((e) => {
      const p = e.templateDocx ? path.join(dir, e.templateDocx) : null;
      let size: number | null = null;
      let lastModified: string | null = null;
      let hasBackup = false;
      if (p && fs.existsSync(p)) {
        const stat = fs.statSync(p);
        size = stat.size;
        lastModified = stat.mtime.toISOString();
        hasBackup = fs.existsSync(p + '.backup.docx');
      }
      return {
        typ: e.typ,
        filename: e.templateDocx ?? null,
        size,
        lastModified,
        hasBackup,
      };
    });
    res.json(list);
  } catch (err) {
    logger.error('Fehler beim Laden der Letter-Templates', { error: err });
    res.status(500).json({ error: 'Fehler beim Laden der Templates' });
  }
});

// GET /:typ/download — stream current DOCX
router.get('/:typ/download', authMiddleware, (req: Request, res: Response): void => {
  const typ = decodeURIComponent(String(req.params.typ ?? ''));
  const entry = findEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Unbekannter Typ: ${typ}` });
    return;
  }
  const p = path.join(findStandardschreibenDir(), entry.templateDocx);
  if (!fs.existsSync(p)) {
    res.status(404).json({ error: 'Template-Datei nicht gefunden' });
    return;
  }
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(path.basename(entry.templateDocx))}"`,
  );
  res.send(fs.readFileSync(p));
});

// PUT /:typ — upload new template (multipart, field: template)
router.put('/:typ', authMiddleware, (req: Request, res: Response): void => {
  const typ = decodeURIComponent(String(req.params.typ ?? ''));
  const entry = findEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Unbekannter Typ: ${typ}` });
    return;
  }
  upload(req, res, (uploadErr) => {
    if (uploadErr) {
      res.status(400).json({ error: uploadErr.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Keine Datei hochgeladen (Feldname: template)' });
      return;
    }
    let uploadedText: string;
    try { uploadedText = extractDocxText(req.file.buffer); }
    catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const required = getRequiredPlaceholders(typ);
    const missing = required.filter((placeholder) => !uploadedText.includes(placeholder));
    if (missing.length > 0) {
      res.status(422).json({ error: 'Pflicht-Platzhalter fehlen', missing });
      return;
    }
    try {
      const templatePath = path.join(findStandardschreibenDir(), entry.templateDocx!);
      const backupPath = templatePath + '.backup.docx';
      if (fs.existsSync(templatePath)) fs.copyFileSync(templatePath, backupPath);
      fs.writeFileSync(templatePath, req.file.buffer);
      invalidateLetterMappingCache();
      logger.info('Letter-Template aktualisiert', { typ, filename: entry.templateDocx });
      res.json({ ok: true, filename: entry.templateDocx });
    } catch (err) {
      logger.error('Fehler beim Speichern des Letter-Templates', { error: err, typ });
      res.status(500).json({ error: 'Fehler beim Speichern des Templates' });
    }
  });
});

// POST /:typ/rollback — restore .backup.docx
router.post('/:typ/rollback', authMiddleware, (req: Request, res: Response): void => {
  const typ = decodeURIComponent(String(req.params.typ ?? ''));
  const entry = findEntry(typ);
  if (!entry?.templateDocx) {
    res.status(404).json({ error: `Unbekannter Typ: ${typ}` });
    return;
  }
  const p = path.join(findStandardschreibenDir(), entry.templateDocx);
  const backup = p + '.backup.docx';
  if (!fs.existsSync(backup)) {
    res.status(404).json({ error: 'Kein Backup vorhanden' });
    return;
  }
  try {
    fs.copyFileSync(backup, p);
    fs.unlinkSync(backup);
    logger.info('Letter-Template zurückgerollt', { typ });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Fehler beim Rollback Letter-Template', { error: err, typ });
    res.status(500).json({ error: 'Fehler beim Rollback' });
  }
});

export default router;
