import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireExtractionAccess } from '../middleware/extractionAccess';
import { uploadMiddleware, validatePdfBuffer } from '../middleware/upload';
import { getDb } from '../db/database';
import { readResultJson, writeResultJson } from '../db/resultJson';
import { config } from '../config';
import { logger } from '../utils/logger';
import { classifySegmentSourceType } from '../utils/documentAnalyzer';
import { applyFocusedResults } from '../services/documentMerge';
import { computeExtractionStats } from '../utils/computeStats';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { extractTextPerPage } from '../services/pdfProcessor';
import { runSupplementJob, getJobState } from '../services/documentJob';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult, DocumentInfo, MergeDiff } from '../types/extraction';

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
  requireExtractionAccess(),
  (req: Request, res: Response, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const { extractionId } = req.access!;

    if (!req.file) { res.status(400).json({ error: 'Keine PDF-Datei hochgeladen' }); return; }

    try {
      validatePdfBuffer(req.file.buffer);
    } catch {
      res.status(400).json({ error: 'Datei ist kein gültiges PDF.' }); return;
    }

    const db = getDb();
    const extraction = db.prepare(
      'SELECT id, status, result_json FROM extractions WHERE id = ?'
    ).get(extractionId) as { id: number; status: string; result_json: string | null } | undefined;

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

// --- 2. Extract + Diff (async job) ---
//
// The supplement pipeline now runs OCR + focused array passes + handwriting,
// so it can take >60s. Returns 202 immediately and runs the job in the background;
// clients poll GET /status or /jobs/active for progress.

router.post('/:extractionId/documents/:docId/extract', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const { extractionId } = req.access!;
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const extraction = db.prepare(
    'SELECT id FROM extractions WHERE id = ? AND status = ?'
  ).get(extractionId, 'completed') as { id: number } | undefined;
  if (!extraction) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
    .get(docId, extractionId) as DocumentInfo & { job_status: string } | undefined;
  if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  if (doc.job_status === 'pending' || doc.job_status === 'processing') {
    res.status(409).json({ error: 'Ergänzungs-Job läuft bereits', jobStatus: doc.job_status });
    return;
  }

  const sourceTypeOverride = typeof req.body?.sourceType === 'string' ? req.body.sourceType : undefined;

  // Mark pending before returning so the navbar polls pick it up immediately.
  db.prepare(`
    UPDATE documents
    SET job_status = 'pending', job_progress = 0, job_message = 'In Warteschlange…',
        job_error = NULL, job_diff_json = NULL, job_started_at = NULL, job_finished_at = NULL
    WHERE id = ?
  `).run(docId);

  // Fire-and-forget: the worker is resilient and updates the DB row itself.
  setImmediate(() => {
    runSupplementJob(extractionId, docId, sourceTypeOverride).catch(err => {
      logger.error('runSupplementJob unhandled', {
        extractionId, docId, error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  res.status(202).json({ docId, jobStatus: 'pending' });
});

// --- 2b. Job status for a single document ---

router.get('/:extractionId/documents/:docId/status', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const state = getJobState(docId);
  if (!state) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  res.json(state);
});

// --- 2c. Active jobs for current user (navbar polling) ---

router.get('/documents/jobs/active', authMiddleware, (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const isAdmin = req.user!.role === 'admin';
  const db = getDb();

  const rows = db.prepare(
    isAdmin
      ? `SELECT d.id as docId, d.extraction_id as extractionId, d.original_filename as filename,
                d.source_type as sourceType, d.job_status as status, d.job_progress as progress,
                d.job_message as message, d.job_error as error, d.job_started_at as startedAt,
                d.job_finished_at as finishedAt
         FROM documents d
         WHERE d.job_status IN ('pending', 'processing', 'completed', 'failed')
           AND (d.job_finished_at IS NULL OR d.job_finished_at > datetime('now', '-10 minutes'))
         ORDER BY COALESCE(d.job_started_at, d.uploaded_at) DESC`
      : `SELECT d.id as docId, d.extraction_id as extractionId, d.original_filename as filename,
                d.source_type as sourceType, d.job_status as status, d.job_progress as progress,
                d.job_message as message, d.job_error as error, d.job_started_at as startedAt,
                d.job_finished_at as finishedAt
         FROM documents d
         JOIN extractions e ON e.id = d.extraction_id
         WHERE (e.user_id = ?
                OR EXISTS (SELECT 1 FROM extraction_shares s WHERE s.extraction_id = e.id AND s.user_id = ?))
           AND d.job_status IN ('pending', 'processing', 'completed', 'failed')
           AND (d.job_finished_at IS NULL OR d.job_finished_at > datetime('now', '-10 minutes'))
         ORDER BY COALESCE(d.job_started_at, d.uploaded_at) DESC`
  ).all(...(isAdmin ? [] : [userId, userId]));

  res.json(rows);
});

// --- 3. Apply ---

router.post('/:extractionId/documents/:docId/apply', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const userId = req.user!.userId;
  const { extractionId } = req.access!;
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const extraction = db.prepare(
    'SELECT id, result_json FROM extractions WHERE id = ? AND status = ?'
  ).get(extractionId, 'completed') as { id: number; result_json: string | null } | undefined;

  if (!extraction || !extraction.result_json) { res.status(404).json({ error: 'Extraktion nicht gefunden' }); return; }

  const { acceptAll, accept } = req.body as {
    acceptAll?: boolean;
    accept?: string[];
  };

  const result = readResultJson<ExtractionResult>(extraction.result_json)!;

  const accepted = new Set<string>();
  if (accept) for (const p of accept) accepted.add(p);

  const changes = req.body.changes as Array<{ path: string; wert: unknown; quelle: string }> | undefined;

  // Load stored diff from the background job (may contain focused-pass arrays to auto-merge).
  const jobRow = db.prepare('SELECT job_diff_json FROM documents WHERE id = ?')
    .get(docId) as { job_diff_json: string | null } | undefined;
  const storedDiff = jobRow?.job_diff_json ? (JSON.parse(jobRow.job_diff_json) as MergeDiff) : null;

  // Scalar changes
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

  // Auto-merge focused-pass array additions (Forderungen/Aktiva/Anfechtung).
  // These are append-only by composite-key diff — no user-level conflict here.
  const { added: arrayAdded } = applyFocusedResults(result, storedDiff?.focusedResults);

  const revalidated = validateLettersAgainstChecklists(result);
  const stats = computeExtractionStats(revalidated);
  db.prepare(`
    UPDATE extractions SET result_json = ?, stats_found = ?, stats_missing = ?, stats_letters_ready = ?
    WHERE id = ?
  `).run(writeResultJson(revalidated), stats.found, stats.missing, stats.lettersReady, extractionId);

  // Clear job state so the navbar stops showing this supplement.
  db.prepare(`
    UPDATE documents
    SET job_status = 'idle', job_progress = 0, job_message = NULL,
        job_diff_json = NULL, job_error = NULL
    WHERE id = ?
  `).run(docId);

  db.prepare(
    'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)'
  ).run(userId, 'document_merge', JSON.stringify({
    extractionId, docId,
    fieldsApplied: changes?.length ?? 0,
    arrayAdded,
  }), req.ip);

  logger.info('Dokument-Merge angewendet', {
    extractionId, docId,
    fieldsApplied: changes?.length ?? 0,
    arrayAdded,
    statsFound: stats.found,
  });

  res.json({
    result: revalidated,
    statsFound: stats.found,
    statsMissing: stats.missing,
    statsLettersReady: stats.lettersReady,
    arrayAdded,
  });
});

// --- 4. List documents for an extraction ---

router.get('/:extractionId/documents', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const { extractionId } = req.access!;
  const db = getDb();

  const docs = db.prepare('SELECT * FROM documents WHERE extraction_id = ? ORDER BY doc_index')
    .all(extractionId) as DocumentInfo[];

  res.json(docs);
});

// --- 5. Serve a specific document's PDF ---

router.get('/:extractionId/documents/:docId/pdf', authMiddleware, requireExtractionAccess(), (req: Request, res: Response): void => {
  const { extractionId } = req.access!;
  const docId = parseInt(parseParam(req.params['docId']), 10);
  if (isNaN(docId)) { res.status(400).json({ error: 'Ungültige ID' }); return; }

  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
    .get(docId, extractionId) as DocumentInfo | undefined;
  if (!doc) { res.status(404).json({ error: 'Dokument nicht gefunden' }); return; }

  const dir = pdfDir(extractionId);
  // For gerichtsakte (doc_index 0), use 0_gerichtsakte.pdf naming
  const pdfFilename = (doc as any).doc_index === 0 ? '0_gerichtsakte.pdf' : `doc_${(doc as any).doc_index}.pdf`;
  const pdfPath = path.join(dir, pdfFilename);
  if (!fs.existsSync(pdfPath)) { res.status(404).json({ error: 'PDF nicht verfügbar' }); return; }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent((doc as any).original_filename)}"`);
  fs.createReadStream(pdfPath).pipe(res);
});

export default router;
