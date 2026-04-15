import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { uploadMiddleware, validatePdfBuffer } from '../middleware/upload';
import { getDb } from '../db/database';
import { readResultJson, writeResultJson } from '../db/resultJson';
import { config } from '../config';
import { logger } from '../utils/logger';
import { classifySegmentSourceType } from '../utils/documentAnalyzer';
import { executeFieldPack } from '../utils/scalarPackExtractor';
import { SCALAR_PACKS } from '../utils/fieldPacks';
import { computeMergeDiff } from '../services/documentMerge';
import { computeExtractionStats } from '../utils/computeStats';
import { extractTextPerPage } from '../services/pdfProcessor';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult, ExtractionCandidate, DocumentInfo, SegmentSourceType, AnchorPacket } from '../types/extraction';

const router = Router();

/** Safely parse a route param that may be string or string[] */
function parseParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] ?? '';
  return param ?? '';
}

/**
 * Helper: resolve PDF directory for an extraction.
 */
function pdfDir(extractionId: number): string {
  const base = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
  return path.join(base, String(extractionId));
}

/**
 * Helper: get next doc_index for an extraction.
 */
function nextDocIndex(extractionId: number): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT MAX(doc_index) as maxIdx FROM documents WHERE extraction_id = ?'
  ).get(extractionId) as { maxIdx: number | null } | undefined;
  return (row?.maxIdx ?? -1) + 1;
}

// --- 1. Upload + Classify ---

router.post(
  '/:extractionId/documents',
  authMiddleware,
  (req: Request, res: Response, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const extractionId = parseInt(parseParam(req.params['extractionId']), 10);
    if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

    if (!req.file) { res.status(400).json({ error: 'Keine PDF-Datei hochgeladen' }); return; }

    try {
      validatePdfBuffer(req.file.buffer);
    } catch {
      res.status(400).json({ error: 'Datei ist kein gültiges PDF.' }); return;
    }

    // Verify extraction exists and belongs to user
    const db = getDb();
    const isAdmin = req.user!.role === 'admin';
    const extraction = db.prepare(
      isAdmin
        ? 'SELECT id, status, result_json FROM extractions WHERE id = ?'
        : 'SELECT id, status, result_json FROM extractions WHERE id = ? AND user_id = ?'
    ).get(...(isAdmin ? [extractionId] : [extractionId, userId])) as { id: number; status: string; result_json: string | null } | undefined;

    if (!extraction) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }
    if (extraction.status !== 'completed') { res.status(400).json({ error: 'Nur abgeschlossene Extraktionen können ergänzt werden' }); return; }

    // Duplicate check by hash
    const pdfHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const existingDoc = db.prepare(
      'SELECT id FROM documents WHERE extraction_id = ? AND pdf_hash = ?'
    ).get(extractionId, pdfHash) as { id: number } | undefined;

    if (existingDoc) {
      res.status(409).json({ error: 'Dieses Dokument wurde bereits hinzugefügt.' }); return;
    }

    // Extract page texts for classification
    const pageTexts = await extractTextPerPage(req.file.buffer);
    const pageCount = pageTexts.length;

    // Classify: build a pseudo-segment from all pages and classify
    const combinedText = pageTexts.join(' ').slice(0, 2000);
    const segment = { type: '', pages: Array.from({ length: pageCount }, (_, i) => i + 1), description: combinedText };
    const sourceType = classifySegmentSourceType(segment);

    // Store PDF
    const docIndex = nextDocIndex(extractionId);
    const dir = pdfDir(extractionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const pdfFilename = `doc_${docIndex}.pdf`;
    fs.writeFileSync(path.join(dir, pdfFilename), req.file.buffer);

    // Insert document record
    const insertResult = db.prepare(`
      INSERT INTO documents (extraction_id, doc_index, source_type, original_filename, page_count, pdf_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(extractionId, docIndex, sourceType, req.file.originalname, pageCount, pdfHash);
    const docId = Number(insertResult.lastInsertRowid);

    // Debtor name mismatch warning
    let warning: string | null = null;
    if (extraction.result_json) {
      const existingResult = readResultJson<ExtractionResult>(extraction.result_json);
      const existingName = existingResult?.schuldner?.name?.wert || existingResult?.schuldner?.firma?.wert;
      if (existingName && combinedText.length > 100) {
        const nameStr = String(existingName);
        if (!combinedText.toLowerCase().includes(nameStr.toLowerCase().slice(0, 6))) {
          warning = `Schuldnername "${nameStr}" nicht im Dokument gefunden. Prüfen Sie, ob das Dokument zur richtigen Akte gehört.`;
        }
      }
    }

    logger.info('Dokument hochgeladen und klassifiziert', { extractionId, docId, docIndex, sourceType, pageCount });

    // Audit log
    db.prepare(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
    ).run(userId, 'document_upload', JSON.stringify({ extractionId, docId, sourceType, filename: req.file.originalname }), req.ip);

    res.json({ docId, docIndex, sourceType, pageCount, filename: req.file.originalname, warning });
  }
);

// --- 2. Extract + Diff ---

router.post('/:extractionId/documents/:docId/extract', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.userId;
  const extractionId = parseInt(parseParam(req.params['extractionId']), 10);
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(extractionId) || isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const isAdmin = req.user!.role === 'admin';

  // Load extraction
  const extraction = db.prepare(
    isAdmin
      ? 'SELECT id, result_json FROM extractions WHERE id = ? AND status = ?'
      : 'SELECT id, result_json FROM extractions WHERE id = ? AND user_id = ? AND status = ?'
  ).get(...(isAdmin ? [extractionId, 'completed'] : [extractionId, userId, 'completed'])) as { id: number; result_json: string | null } | undefined;

  if (!extraction || !extraction.result_json) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  // Load document
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
    .get(docId, extractionId) as DocumentInfo | undefined;
  if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  // Allow source type override
  const sourceType = (req.body?.sourceType as SegmentSourceType) || doc.sourceType as SegmentSourceType;

  // Read PDF and extract text
  const dir = pdfDir(extractionId);
  const pdfFilename = `doc_${doc.docIndex}.pdf`;
  const pdfPath = path.join(dir, pdfFilename);
  if (!fs.existsSync(pdfPath)) { res.status(404).json({ error: 'PDF-Datei nicht gefunden' }); return; }

  const pdfBuffer = fs.readFileSync(pdfPath);
  const pageTexts = await extractTextPerPage(pdfBuffer);
  const pages = Array.from({ length: pageTexts.length }, (_, i) => i + 1);

  // Find matching field packs for this source type
  const matchingPacks = SCALAR_PACKS.filter(p => p.segmentTypes.includes(sourceType));

  if (matchingPacks.length === 0) {
    // Fallback: run all packs on this document
    logger.warn('Kein passendes Feldpaket für Dokumenttyp', { sourceType });
  }

  const packsToRun = matchingPacks.length > 0 ? matchingPacks : SCALAR_PACKS;

  // Build a minimal anchor from existing result
  const existingResult = readResultJson<ExtractionResult>(extraction.result_json)!;

  // Detect debtor type from rechtsform
  const rechtsform = existingResult.schuldner?.rechtsform?.wert || '';
  const juristischePersonPattern = /gmbh|ag\b|ug\b|se\b|kg\b|ohg|gbr|e\.v\.|stiftung|genossenschaft|partg/i;
  const personengesellschaftPattern = /kg\b|ohg\b|gbr\b|partg/i;
  let debtorType: 'natuerliche_person' | 'juristische_person' | 'personengesellschaft' = 'natuerliche_person';
  if (personengesellschaftPattern.test(rechtsform)) {
    debtorType = 'personengesellschaft';
  } else if (juristischePersonPattern.test(rechtsform)) {
    debtorType = 'juristische_person';
  }

  const anchor: AnchorPacket = {
    aktenzeichen: (existingResult.verfahrensdaten?.aktenzeichen?.wert as string | null) ?? null,
    gericht: (existingResult.verfahrensdaten?.gericht?.wert as string | null) ?? null,
    beschlussdatum: (existingResult.verfahrensdaten?.beschlussdatum?.wert as string | null) ?? null,
    antragsdatum: (existingResult.verfahrensdaten?.antragsdatum?.wert as string | null) ?? null,
    debtor_canonical_name: ((existingResult.schuldner?.name?.wert || existingResult.schuldner?.firma?.wert) as string | null) ?? null,
    debtor_rechtsform: (existingResult.schuldner?.rechtsform?.wert as string | null) ?? null,
    debtor_type: debtorType,
    applicant_canonical_name: (existingResult.antragsteller?.name?.wert as string | null) ?? null,
    gutachter_name: (existingResult.gutachterbestellung?.gutachter_name?.wert as string | null) ?? null,
  };

  // Run field packs
  const allCandidates: ExtractionCandidate[] = [];
  for (const pack of packsToRun) {
    try {
      const candidates = await executeFieldPack(
        pack, pageTexts, pages, [sourceType], anchor, null,
      );
      // Prefix quellen with document type
      for (const c of candidates) {
        if (c.quelle && !c.quelle.includes(doc.originalFilename)) {
          c.quelle = c.quelle.replace(/^Seite/i, `${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)}, Seite`);
        }
      }
      allCandidates.push(...candidates);
    } catch (err) {
      logger.error(`Feldpaket "${pack.id}" fehlgeschlagen`, {
        error: err instanceof Error ? err.message : String(err),
        packId: pack.id,
      });
    }
  }

  // Compute diff
  const diff = computeMergeDiff(existingResult, allCandidates);

  logger.info('Dokument-Extraktion + Diff abgeschlossen', {
    extractionId, docId, sourceType,
    candidates: allCandidates.length,
    newFields: diff.newFields.length,
    updatedFields: diff.updatedFields.length,
    conflicts: diff.conflicts.length,
  });

  res.json(diff);
});

// --- 3. Apply ---

router.post('/:extractionId/documents/:docId/apply', authMiddleware, (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const extractionId = parseInt(parseParam(req.params['extractionId']), 10);
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(extractionId) || isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const isAdmin = req.user!.role === 'admin';

  const extraction = db.prepare(
    isAdmin
      ? 'SELECT id, result_json FROM extractions WHERE id = ? AND status = ?'
      : 'SELECT id, result_json FROM extractions WHERE id = ? AND user_id = ? AND status = ?'
  ).get(...(isAdmin ? [extractionId, 'completed'] : [extractionId, userId, 'completed'])) as { id: number; result_json: string | null } | undefined;

  if (!extraction || !extraction.result_json) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  const { acceptAll, accept } = req.body as {
    acceptAll?: boolean;
    accept?: string[];
  };

  const result = readResultJson<ExtractionResult>(extraction.result_json)!;

  // Build accepted set
  const accepted = new Set<string>();
  if (acceptAll) {
    if (accept) {
      for (const p of accept) accepted.add(p);
    }
  } else if (accept) {
    for (const p of accept) accepted.add(p);
  }

  if (accepted.size === 0 && !acceptAll) {
    res.status(400).json({ error: 'Keine Änderungen zum Anwenden ausgewählt' }); return;
  }

  // Apply changes directly from the changes array in request body
  const changes = req.body.changes as Array<{ path: string; wert: unknown; quelle: string }> | undefined;
  if (changes) {
    for (const change of changes) {
      if (!acceptAll && !accepted.has(change.path)) continue;

      const parts = change.path.split('.');
      let obj: Record<string, unknown> = result as unknown as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      const leafKey = parts[parts.length - 1];
      const field = obj[leafKey] as Record<string, unknown> | undefined;
      if (field && typeof field === 'object') {
        field.wert = change.wert;
        field.quelle = change.quelle;
        field.verifiziert = false;
        delete field.pruefstatus;
      } else {
        obj[leafKey] = { wert: change.wert, quelle: change.quelle, verifiziert: false };
      }
    }
  }

  // Recompute stats and save
  const stats = computeExtractionStats(result);
  db.prepare(`
    UPDATE extractions SET result_json = ?, stats_found = ?, stats_missing = ?, stats_letters_ready = ?
    WHERE id = ?
  `).run(writeResultJson(result), stats.found, stats.missing, stats.lettersReady, extractionId);

  // Audit log
  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'document_merge', JSON.stringify({
    extractionId, docId,
    fieldsApplied: changes?.length ?? 0,
  }), req.ip);

  logger.info('Dokument-Merge angewendet', {
    extractionId, docId,
    fieldsApplied: changes?.length ?? 0,
    statsFound: stats.found,
  });

  res.json({ statsFound: stats.found, statsMissing: stats.missing, statsLettersReady: stats.lettersReady });
});

// --- 4. List documents for an extraction ---

router.get('/:extractionId/documents', authMiddleware, (req: Request, res: Response): void => {
  const extractionId = parseInt(parseParam(req.params['extractionId']), 10);
  if (isNaN(extractionId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const userId = req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  const db = getDb();

  // Verify ownership
  const extraction = db.prepare(
    isAdmin
      ? 'SELECT id FROM extractions WHERE id = ?'
      : 'SELECT id FROM extractions WHERE id = ? AND user_id = ?'
  ).get(...(isAdmin ? [extractionId] : [extractionId, userId])) as { id: number } | undefined;

  if (!extraction) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  const docs = db.prepare('SELECT * FROM documents WHERE extraction_id = ? ORDER BY doc_index')
    .all(extractionId) as DocumentInfo[];

  res.json(docs);
});

// --- 5. Serve a specific document's PDF ---

router.get('/:extractionId/documents/:docId/pdf', authMiddleware, (req: Request, res: Response): void => {
  const extractionId = parseInt(parseParam(req.params['extractionId']), 10);
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(extractionId) || isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const userId = req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  const db = getDb();

  // Verify ownership
  const extraction = db.prepare(
    isAdmin
      ? 'SELECT id FROM extractions WHERE id = ?'
      : 'SELECT id FROM extractions WHERE id = ? AND user_id = ?'
  ).get(...(isAdmin ? [extractionId] : [extractionId, userId])) as { id: number } | undefined;

  if (!extraction) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
    .get(docId, extractionId) as DocumentInfo | undefined;
  if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  const dir = pdfDir(extractionId);
  // For gerichtsakte (doc_index 0), use 0_gerichtsakte.pdf naming
  const pdfFilename = doc.docIndex === 0 ? '0_gerichtsakte.pdf' : `doc_${doc.docIndex}.pdf`;
  const pdfPath = path.join(dir, pdfFilename);
  if (!fs.existsSync(pdfPath)) { res.status(404).json({ error: 'PDF nicht verfügbar' }); return; }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.originalFilename)}"`);
  fs.createReadStream(pdfPath).pipe(res);
});

export default router;
