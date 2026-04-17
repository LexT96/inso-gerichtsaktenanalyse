import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../utils/logger';
import { invalidateKanzleiCache } from '../utils/gutachtenGenerator';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import PizZip from 'pizzip';

const router = Router();

const TEMPLATE_TYPES = ['natuerliche_person', 'juristische_person', 'personengesellschaft'] as const;
type TemplateType = typeof TEMPLATE_TYPES[number];

const REQUIRED_PLACEHOLDERS: Record<TemplateType, string[]> = {
  natuerliche_person: ['KI_Gericht_Ort', 'KI_Akte_GerichtAZ', 'KI_Verwalter_Name', 'KI_Schuldner_NameVorname', 'KI_Schuldner_Geburtsdatum'],
  juristische_person: ['KI_Gericht_Ort', 'KI_Akte_GerichtAZ', 'KI_Verwalter_Name', 'KI_Schuldner_Firma', 'KI_Schuldner_Rechtsform'],
  personengesellschaft: ['KI_Gericht_Ort', 'KI_Akte_GerichtAZ', 'KI_Verwalter_Name', 'KI_Schuldner_Firma'],
};

// multer instance for template DOCX uploads (memory storage, 10 MB limit)
const templateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('template');

function findKanzleiPath(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'gutachtenvorlagen', 'kanzlei.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), 'gutachtenvorlagen', 'kanzlei.json');
}

function findTemplatesDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'gutachtenvorlagen');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), 'gutachtenvorlagen');
}

function getTemplateFilenames(): Record<TemplateType, string> {
  const templatesDir = findTemplatesDir();
  const mappingPath = path.join(templatesDir, 'gutachten-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as {
    templates: Record<TemplateType, string>;
  };
  return mapping.templates;
}

function extractDocxText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) throw new Error('word/document.xml nicht gefunden — keine gültige DOCX-Datei.');
  const xml = documentXml.asText();
  // Extract all <w:t> text content joined together — handles Word run-splitting
  // where KI_Gericht_Ort might be split as <w:t>KI_</w:t><w:t>Gericht_Ort</w:t>
  const texts: string[] = [];
  const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    texts.push(match[1]);
  }
  return texts.join('');
}

function validateTemplate(buffer: Buffer, type: TemplateType): string[] {
  const fullText = extractDocxText(buffer);
  const required = REQUIRED_PLACEHOLDERS[type];
  return required.filter((placeholder) => !fullText.includes(placeholder));
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

// PUT / — write kanzlei.json
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
    res.json({ ok: true });
  } catch (err) {
    logger.error('Fehler beim Schreiben von kanzlei.json', { error: err });
    res.status(500).json({ error: 'Fehler beim Speichern der Kanzleidaten' });
  }
});

// GET /templates — list all 3 Gutachten templates with file info
router.get('/templates', authMiddleware, (_req: Request, res: Response): void => {
  try {
    const templatesDir = findTemplatesDir();
    const filenames = getTemplateFilenames();
    const result = TEMPLATE_TYPES.map((type) => {
      const filename = filenames[type];
      const filePath = path.join(templatesDir, filename);
      let size: number | null = null;
      let lastModified: string | null = null;
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        size = stat.size;
        lastModified = stat.mtime.toISOString();
      }
      return { type, filename, size, lastModified };
    });
    res.json(result);
  } catch (err) {
    logger.error('Fehler beim Laden der Template-Liste', { error: err });
    res.status(500).json({ error: 'Fehler beim Laden der Templates' });
  }
});

// GET /templates/:type/download — download current template DOCX
router.get('/templates/:type/download', authMiddleware, (req: Request, res: Response): void => {
  const { type } = req.params;
  if (!TEMPLATE_TYPES.includes(type as TemplateType)) {
    res.status(400).json({ error: `Unbekannter Template-Typ: ${type}` });
    return;
  }
  try {
    const templatesDir = findTemplatesDir();
    const filenames = getTemplateFilenames();
    const filename = filenames[type as TemplateType];
    const filePath = path.join(templatesDir, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Template-Datei nicht gefunden' });
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    const buffer = fs.readFileSync(filePath);
    res.send(buffer);
  } catch (err) {
    logger.error('Fehler beim Download des Templates', { error: err, type: req.params.type });
    res.status(500).json({ error: 'Fehler beim Herunterladen des Templates' });
  }
});

// PUT /templates/:type — upload new template DOCX (validates KI_* placeholders, creates backup)
router.put('/templates/:type', authMiddleware, (req: Request, res: Response): void => {
  const { type } = req.params;
  if (!TEMPLATE_TYPES.includes(type as TemplateType)) {
    res.status(400).json({ error: `Unbekannter Template-Typ: ${type}` });
    return;
  }

  templateUpload(req, res, (uploadErr) => {
    if (uploadErr) {
      logger.warn('Template-Upload fehlgeschlagen', { error: uploadErr });
      res.status(400).json({ error: uploadErr.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Keine Datei hochgeladen (Feldname: template)' });
      return;
    }

    const buffer = req.file.buffer;

    // Validate DOCX structure and required placeholders
    let missingPlaceholders: string[];
    try {
      missingPlaceholders = validateTemplate(buffer, type as TemplateType);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    if (missingPlaceholders.length > 0) {
      res.status(422).json({
        error: 'Pflicht-Platzhalter fehlen in der hochgeladenen Vorlage',
        missing: missingPlaceholders,
      });
      return;
    }

    try {
      const templatesDir = findTemplatesDir();
      const filenames = getTemplateFilenames();
      const filename = filenames[type as TemplateType];
      const filePath = path.join(templatesDir, filename);
      const backupPath = filePath + '.backup.docx';

      // Back up current template before overwriting
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
        logger.info('Template-Backup erstellt', { backup: backupPath });
      }

      fs.writeFileSync(filePath, buffer);
      logger.info('Template aktualisiert', { type, filename });
      res.json({ ok: true, filename });
    } catch (err) {
      logger.error('Fehler beim Speichern des Templates', { error: err, type });
      res.status(500).json({ error: 'Fehler beim Speichern des Templates' });
    }
  });
});

// POST /templates/:type/rollback — restore backup template
router.post('/templates/:type/rollback', authMiddleware, (req: Request, res: Response): void => {
  const { type } = req.params;
  if (!TEMPLATE_TYPES.includes(type as TemplateType)) {
    res.status(400).json({ error: `Unbekannter Template-Typ: ${type}` });
    return;
  }

  try {
    const templatesDir = findTemplatesDir();
    const filenames = getTemplateFilenames();
    const filename = filenames[type as TemplateType];
    const filePath = path.join(templatesDir, filename);
    const backupPath = filePath + '.backup.docx';

    if (!fs.existsSync(backupPath)) {
      res.status(404).json({ error: 'Kein Backup vorhanden' });
      return;
    }

    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    logger.info('Template-Rollback durchgeführt', { type, filename });
    res.json({ ok: true, filename });
  } catch (err) {
    logger.error('Fehler beim Rollback des Templates', { error: err, type: req.params.type });
    res.status(500).json({ error: 'Fehler beim Rollback des Templates' });
  }
});

export default router;
