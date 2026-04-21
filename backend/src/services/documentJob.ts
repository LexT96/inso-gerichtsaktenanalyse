import fs from 'fs';
import path from 'path';
import { getDb } from '../db/database';
import { readResultJson } from '../db/resultJson';
import { logger } from '../utils/logger';
import { extractTextPerPage, removeWatermarksFromTexts } from './pdfProcessor';
import { isScannedPdf, isOcrConfigured, ocrPdf, type OcrResult } from './ocrService';
import { executeFieldPack } from '../utils/scalarPackExtractor';
import { SCALAR_PACKS, ANCHOR_PACK } from '../utils/fieldPacks';
import { extractForderungen } from '../utils/forderungenExtractor';
import { extractAktiva } from '../utils/aktivaExtractor';
import { analyzeAnfechtung } from '../utils/anfechtungsAnalyzer';
import { callWithRetry, createAnthropicMessage, extractJsonFromText } from './anthropic';
import { computeMergeDiff, summarizeFocusedResults } from './documentMerge';
import { config } from '../config';
import type {
  ExtractionResult,
  ExtractionCandidate,
  DocumentInfo,
  SegmentSourceType,
  AnchorPacket,
  MergeDiff,
  Forderungen,
  AktivaAnalyse,
  Anfechtungsanalyse,
} from '../types/extraction';

export type DocumentJobStatus = 'idle' | 'pending' | 'processing' | 'completed' | 'failed';

/** Mapping of which focused extractor to run based on classified source type. */
const FOCUSED_TYPE_MAP: Record<string, 'forderungen' | 'aktiva' | 'anfechtung' | null> = {
  forderungstabelle: 'forderungen',
  vermoegensverzeichnis: 'aktiva',
  grundbuch: 'aktiva',
  // anfechtung has no direct supplement source type — only triggered if user overrides
};

const FRAGEBOGEN_MARKERS = [
  'fragebogen',
  'ermittlung der wirtschaftlichen',
  'ergänzende betriebliche angaben',
  'vermögensübersicht',
  'ergänzungsblatt',
];

function detectFragebogenPages(pageTexts: string[]): number[] {
  const pages: number[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const lower = (pageTexts[i] ?? '').toLowerCase();
    if (FRAGEBOGEN_MARKERS.some(m => lower.includes(m))) pages.push(i);
  }
  return pages;
}

const HANDWRITING_PROMPT = `Du bist ein OCR-Spezialist für handschriftlich ausgefüllte deutsche Insolvenz-Fragebögen.

AUFGABE: Lies JEDES handschriftlich ausgefüllte Feld in diesen Formularseiten. Die Formulare sind vorgedruckt mit Feldnamen, und der Antragsteller hat die Werte HANDSCHRIFTLICH eingetragen.

Antworte AUSSCHLIESSLICH mit validem JSON. Format pro Feld:
{ "feld_key": { "wert": "…", "quelle": "Seite X, Abschnitt …" } }

Erlaubte feld_keys: telefon, mobiltelefon, email, betriebsstaette_adresse, geschaeftszweig, unternehmensgegenstand, finanzamt, steuernummer, ust_id, steuerberater, sozialversicherungstraeger, letzter_jahresabschluss, bankverbindungen, aktuelle_adresse, firma, familienstand, geschlecht, arbeitnehmer_anzahl, betriebsrat.

Wenn ein Feld leer oder nicht lesbar: NICHT aufnehmen.`;

/** Map a handwriting field key to the ExtractionCandidate fieldPath in schuldner.*  */
const HANDWRITING_FIELD_PATHS: Record<string, string> = {
  telefon: 'schuldner.telefon',
  mobiltelefon: 'schuldner.mobiltelefon',
  email: 'schuldner.email',
  betriebsstaette_adresse: 'schuldner.betriebsstaette_adresse',
  geschaeftszweig: 'schuldner.geschaeftszweig',
  unternehmensgegenstand: 'schuldner.unternehmensgegenstand',
  finanzamt: 'schuldner.finanzamt',
  steuernummer: 'schuldner.steuernummer',
  ust_id: 'schuldner.ust_id',
  steuerberater: 'schuldner.steuerberater',
  sozialversicherungstraeger: 'schuldner.sozialversicherungstraeger',
  letzter_jahresabschluss: 'schuldner.letzter_jahresabschluss',
  bankverbindungen: 'schuldner.bankverbindungen',
  aktuelle_adresse: 'schuldner.aktuelle_adresse',
  firma: 'schuldner.firma',
  familienstand: 'schuldner.familienstand',
  geschlecht: 'schuldner.geschlecht',
  arbeitnehmer_anzahl: 'schuldner.arbeitnehmer_anzahl',
  betriebsrat: 'schuldner.betriebsrat',
};

async function runHandwritingPass(
  pageTexts: string[],
  pdfBuffer: Buffer,
): Promise<ExtractionCandidate[]> {
  const formPages = detectFragebogenPages(pageTexts);
  if (formPages.length === 0) return [];

  logger.info('Supplement: Fragebogen-Seiten erkannt, Handschrift-Pass startet', {
    pages: formPages.map(p => p + 1),
  });

  const pageMapping = formPages.map(p => `Seite ${p + 1}`).join(', ');
  const textBlock = formPages.map(p => `=== SEITE ${p + 1} ===\n${pageTexts[p] ?? ''}`).join('\n\n');

  let response;
  try {
    response = await callWithRetry(() => createAnthropicMessage({
      model: config.EXTRACTION_MODEL,
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: 'user' as const,
        content: `${HANDWRITING_PROMPT}\n\nSeiten in diesem Dokument: ${pageMapping}\n\n--- FORMULARE (OCR/Text) ---\n\n${textBlock}`,
      }],
    }));
  } catch (err) {
    logger.warn('Supplement Handschrift-Pass Anfrage fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');

  let parsed: Record<string, { wert: unknown; quelle: string }>;
  try {
    const jsonStr = extractJsonFromText(text);
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      const { jsonrepair } = await import('jsonrepair');
      parsed = JSON.parse(jsonrepair(jsonStr));
    }
  } catch (err) {
    logger.warn('Supplement Handschrift-JSON unlesbar', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const candidates: ExtractionCandidate[] = [];
  for (const [key, raw] of Object.entries(parsed)) {
    if (!raw?.wert) continue;
    const fieldPath = HANDWRITING_FIELD_PATHS[key];
    if (!fieldPath) continue;
    candidates.push({
      fieldPath,
      wert: raw.wert,
      quelle: `${raw.quelle} (Handschrift-Extraktion)`,
      page: null,
      segmentType: 'fragebogen',
      packId: 'handwriting',
    });
  }

  logger.info('Supplement Handschrift-Pass abgeschlossen', { candidates: candidates.length });
  return candidates;
}

function pdfDir(extractionId: number): string {
  const base = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
  return path.join(base, String(extractionId));
}

function docPdfPath(extractionId: number, docIndex: number): string {
  return path.join(pdfDir(extractionId), `doc_${docIndex}.pdf`);
}

function updateJob(docId: number, patch: {
  status?: DocumentJobStatus;
  progress?: number;
  message?: string | null;
  error?: string | null;
  diff?: MergeDiff | null;
}): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.status !== undefined) {
    fields.push('job_status = ?');
    values.push(patch.status);
    if (patch.status === 'processing') {
      fields.push("job_started_at = datetime('now')");
    }
    if (patch.status === 'completed' || patch.status === 'failed') {
      fields.push("job_finished_at = datetime('now')");
    }
  }
  if (patch.progress !== undefined) { fields.push('job_progress = ?'); values.push(patch.progress); }
  if (patch.message !== undefined) { fields.push('job_message = ?'); values.push(patch.message); }
  if (patch.error !== undefined) { fields.push('job_error = ?'); values.push(patch.error); }
  if (patch.diff !== undefined) {
    fields.push('job_diff_json = ?');
    values.push(patch.diff ? JSON.stringify(patch.diff) : null);
  }
  if (fields.length === 0) return;
  values.push(docId);
  db.prepare(`UPDATE documents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getJobState(docId: number): {
  status: DocumentJobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  diff: MergeDiff | null;
} | null {
  const row = getDb().prepare(
    'SELECT job_status, job_progress, job_message, job_error, job_diff_json FROM documents WHERE id = ?'
  ).get(docId) as {
    job_status: string;
    job_progress: number;
    job_message: string | null;
    job_error: string | null;
    job_diff_json: string | null;
  } | undefined;
  if (!row) return null;
  return {
    status: (row.job_status as DocumentJobStatus) || 'idle',
    progress: row.job_progress ?? 0,
    message: row.job_message,
    error: row.job_error,
    diff: row.job_diff_json ? (JSON.parse(row.job_diff_json) as MergeDiff) : null,
  };
}

/**
 * Run the full supplement-extraction pipeline in the background.
 * Updates the documents row as it progresses; callers poll via GET /status.
 *
 * Pipeline:
 *   1. Load PDF, extractTextPerPage
 *   2. If scanned → Azure OCR (cached by hash), replace pageTexts with OCR text
 *   3. Scalar packs — always (anchor + routed packs) → field candidates
 *   4. Focused pass routed by sourceType (forderungstabelle → forderungen, etc.)
 *   5. Handwriting pass if Fragebogen pages detected
 *   6. computeMergeDiff + summarizeFocusedResults → persist
 */
export async function runSupplementJob(extractionId: number, docId: number, sourceTypeOverride?: string): Promise<void> {
  const db = getDb();

  try {
    updateJob(docId, { status: 'processing', progress: 2, message: 'Dokument wird geladen…', error: null });

    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND extraction_id = ?')
      .get(docId, extractionId) as DocumentInfo | undefined;
    if (!doc) throw new Error('Dokument nicht gefunden');

    const extraction = db.prepare('SELECT id, result_json FROM extractions WHERE id = ?')
      .get(extractionId) as { id: number; result_json: string | null } | undefined;
    if (!extraction || !extraction.result_json) throw new Error('Extraktion nicht gefunden oder leer');

    const existingResult = readResultJson<ExtractionResult>(extraction.result_json);
    if (!existingResult) throw new Error('Extraktions-Ergebnis konnte nicht gelesen werden');

    const sourceType = (sourceTypeOverride || (doc as unknown as { source_type: string }).source_type) as SegmentSourceType;

    const pdfPath = docPdfPath(extractionId, (doc as unknown as { doc_index: number }).doc_index);
    if (!fs.existsSync(pdfPath)) throw new Error(`PDF-Datei nicht gefunden: ${pdfPath}`);
    let pdfBuffer = fs.readFileSync(pdfPath);

    // ── Stage 0: pageTexts ──
    updateJob(docId, { progress: 8, message: 'Text wird extrahiert…' });
    let pageTexts = await extractTextPerPage(pdfBuffer);

    // ── Stage 0b: OCR if scanned ──
    let ocrResult: OcrResult | null = null;
    if (isScannedPdf(pageTexts) && isOcrConfigured()) {
      updateJob(docId, { progress: 18, message: 'Scan erkannt — OCR läuft…' });
      try {
        ocrResult = await ocrPdf(pdfBuffer);
        const ocrPageTexts = new Array<string>(pageTexts.length).fill('');
        for (const page of ocrResult.pages) {
          if (page.pageNumber >= 1 && page.pageNumber <= pageTexts.length) {
            ocrPageTexts[page.pageNumber - 1] = page.text;
          }
        }
        pageTexts = removeWatermarksFromTexts(ocrPageTexts);
        logger.info('Supplement OCR abgeschlossen', {
          docId, totalChars: ocrResult.totalChars, pages: ocrResult.pages.length,
        });
      } catch (err) {
        logger.warn('Supplement OCR fehlgeschlagen, nutze Original-Text', {
          docId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const pages = Array.from({ length: pageTexts.length }, (_, i) => i + 1);

    // ── Anchor for scalar packs ──
    const rechtsform = existingResult.schuldner?.rechtsform?.wert || '';
    const juristischePersonPattern = /gmbh|ag\b|ug\b|se\b|kg\b|ohg|gbr|e\.v\.|stiftung|genossenschaft|partg/i;
    const personengesellschaftPattern = /kg\b|ohg\b|gbr\b|partg/i;
    let debtorType: 'natuerliche_person' | 'juristische_person' | 'personengesellschaft' = 'natuerliche_person';
    if (personengesellschaftPattern.test(String(rechtsform))) debtorType = 'personengesellschaft';
    else if (juristischePersonPattern.test(String(rechtsform))) debtorType = 'juristische_person';

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

    // ── Stage 2 — scalar packs ──
    updateJob(docId, { progress: 30, message: 'Scalar-Felder werden extrahiert…' });
    const allPacks = [ANCHOR_PACK, ...SCALAR_PACKS];
    const matchingPacks = allPacks.filter(p => p.segmentTypes.includes(sourceType));
    const packsToRun = matchingPacks.length > 0 ? matchingPacks : allPacks;
    const scalarCandidates: ExtractionCandidate[] = [];
    for (const pack of packsToRun) {
      try {
        const candidates = await executeFieldPack(pack, pageTexts, pages, [sourceType], anchor, ocrResult);
        for (const c of candidates) {
          if (c.quelle && !c.quelle.includes((doc as unknown as { original_filename: string }).original_filename)) {
            c.quelle = c.quelle.replace(/^Seite/i, `${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)}, Seite`);
          }
        }
        scalarCandidates.push(...candidates);
      } catch (err) {
        logger.error(`Supplement Feldpaket "${pack.id}" fehlgeschlagen`, {
          docId, packId: pack.id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Stage 2b — focused pass ──
    const focusedType = FOCUSED_TYPE_MAP[sourceType] ?? null;
    let focusedResults: { forderungen?: Forderungen | null; aktiva?: AktivaAnalyse | null; anfechtung?: Anfechtungsanalyse | null } = {};

    if (focusedType === 'forderungen') {
      updateJob(docId, { progress: 55, message: 'Forderungen werden analysiert…' });
      try {
        focusedResults.forderungen = await extractForderungen(pageTexts, undefined, undefined, ocrResult, pdfBuffer);
      } catch (err) {
        logger.warn('Supplement Forderungen-Pass fehlgeschlagen', { docId, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (focusedType === 'aktiva') {
      updateJob(docId, { progress: 55, message: 'Aktiva werden analysiert…' });
      try {
        focusedResults.aktiva = await extractAktiva(pageTexts, undefined, existingResult, undefined, ocrResult, pdfBuffer);
      } catch (err) {
        logger.warn('Supplement Aktiva-Pass fehlgeschlagen', { docId, error: err instanceof Error ? err.message : String(err) });
      }
    } else if (focusedType === 'anfechtung') {
      updateJob(docId, { progress: 55, message: 'Anfechtung wird analysiert…' });
      try {
        focusedResults.anfechtung = await analyzeAnfechtung(pageTexts, undefined, existingResult, undefined, ocrResult, pdfBuffer);
      } catch (err) {
        logger.warn('Supplement Anfechtung-Pass fehlgeschlagen', { docId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Stage 3c — handwriting pass for Fragebogen ──
    if (sourceType === 'fragebogen' || detectFragebogenPages(pageTexts).length > 0) {
      updateJob(docId, { progress: 80, message: 'Handschriftliche Formularfelder werden gelesen…' });
      try {
        const handwritingCandidates = await runHandwritingPass(pageTexts, pdfBuffer);
        scalarCandidates.push(...handwritingCandidates);
      } catch (err) {
        logger.warn('Supplement Handschrift-Pass fehlgeschlagen', { docId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Build merge diff ──
    updateJob(docId, { progress: 92, message: 'Änderungen werden berechnet…' });
    const diff = computeMergeDiff(existingResult, scalarCandidates);
    if (focusedResults.forderungen || focusedResults.aktiva || focusedResults.anfechtung) {
      diff.focusedResults = focusedResults;
      diff.arraySummary = summarizeFocusedResults(existingResult, focusedResults);
    }

    updateJob(docId, {
      status: 'completed',
      progress: 100,
      message: 'Fertig',
      diff,
    });

    logger.info('Supplement-Job abgeschlossen', {
      extractionId, docId, sourceType,
      newFields: diff.newFields.length,
      conflicts: diff.conflicts.length,
      arraySummary: diff.arraySummary,
    });
  } catch (err) {
    logger.error('Supplement-Job fehlgeschlagen', {
      extractionId, docId,
      error: err instanceof Error ? err.message : String(err),
    });
    updateJob(docId, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      message: 'Fehler',
    });
  }
}
