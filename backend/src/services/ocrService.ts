import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';

/**
 * Azure Document Intelligence OCR service.
 * Submits a PDF, polls for completion, returns extracted text per page.
 * Caches results by PDF content hash to avoid redundant API calls.
 */

const API_VERSION = '2024-11-30';
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_RETRIES = 180; // 3 minutes max wait
const MAX_PDF_SIZE = 4 * 1024 * 1024; // Azure DI limit: 4MB per request

interface OcrWordConfidence {
  text: string;
  confidence: number;
}

interface OcrTableCell {
  rowIndex: number;
  columnIndex: number;
  content: string;
  kind?: string;
}

interface OcrTable {
  rowCount: number;
  columnCount: number;
  cells: OcrTableCell[];
}

interface OcrPageResult {
  pageNumber: number;
  text: string;
  lines: string[];
  /** Per-word confidence scores from Azure (prebuilt-layout) */
  wordConfidences?: OcrWordConfidence[];
  /** Average word confidence for this page (0.0-1.0) */
  avgConfidence?: number;
  /** Detected tables with cell-level structure */
  tables?: OcrTable[];
  /** Low-confidence words (< 0.80) that may contain OCR errors */
  lowConfidenceWords?: OcrWordConfidence[];
}

export interface OcrResult {
  pages: OcrPageResult[];
  totalChars: number;
}

/**
 * Check whether Azure Document Intelligence is configured.
 */
export function isOcrConfigured(): boolean {
  return !!(config.AZURE_DOC_INTEL_ENDPOINT && config.AZURE_DOC_INTEL_KEY);
}

/**
 * Detect whether a PDF is scanned (has little/no embedded text).
 * Returns true if average chars per page is below threshold.
 */
export function isScannedPdf(pageTexts: string[], threshold = 50): boolean {
  if (pageTexts.length === 0) return false;
  const totalChars = pageTexts.reduce((sum, t) => sum + t.trim().length, 0);
  const avgChars = totalChars / pageTexts.length;
  return avgChars < threshold;
}

const OCR_CACHE_DIR = path.join(process.cwd(), 'data', 'ocr-cache');

function getCacheKey(pdfBuffer: Buffer): string {
  return createHash('sha256').update(pdfBuffer).digest('hex').substring(0, 16);
}

function loadFromCache(key: string): OcrResult | null {
  const cachePath = path.join(OCR_CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    logger.info('OCR-Cache-Treffer', { key, pages: data.pages?.length, totalChars: data.totalChars });
    return data as OcrResult;
  } catch {
    return null;
  }
}

function saveToCache(key: string, result: OcrResult): void {
  if (!fs.existsSync(OCR_CACHE_DIR)) fs.mkdirSync(OCR_CACHE_DIR, { recursive: true });
  // Only cache line text (strip wordConfidences to save disk space)
  const slim: OcrResult = {
    pages: result.pages.map(p => ({
      pageNumber: p.pageNumber,
      text: p.text,
      lines: p.lines,
      tables: p.tables,
      avgConfidence: p.avgConfidence,
    })),
    totalChars: result.totalChars,
  };
  fs.writeFileSync(path.join(OCR_CACHE_DIR, `${key}.json`), JSON.stringify(slim));
}

/**
 * Run Azure Document Intelligence OCR on a PDF buffer.
 * Caches results by content hash — same PDF won't be OCR'd twice.
 * For PDFs > 4MB, splits into chunks and processes separately.
 */
export async function ocrPdf(pdfBuffer: Buffer): Promise<OcrResult> {
  if (!isOcrConfigured()) {
    throw new Error('Azure Document Intelligence nicht konfiguriert (AZURE_DOC_INTEL_ENDPOINT / AZURE_DOC_INTEL_KEY fehlt)');
  }

  // Check cache first
  const cacheKey = getCacheKey(pdfBuffer);
  const cached = loadFromCache(cacheKey);
  if (cached) return cached;

  let finalResult: OcrResult;

  if (pdfBuffer.length <= MAX_PDF_SIZE) {
    const result = await analyzeSinglePdf(pdfBuffer, 0);
    // Detect F0 free tier: if we get far fewer pages than expected, fall back to per-page
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const expectedPages = doc.getPageCount();
    if (result.pages.length < expectedPages * 0.5 && expectedPages > 4) {
      logger.warn('Azure DI: Nur wenige Seiten zurück — vermutlich F0 Free Tier, wechsle zu Einzelseiten-Modus', {
        expected: expectedPages, got: result.pages.length,
      });
      finalResult = await analyzePerPage(pdfBuffer);
    } else {
      finalResult = result;
    }
  } else {
    // Split large PDFs into chunks that fit the 4MB limit
    const result = await analyzeInChunks(pdfBuffer);
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const expectedPages = doc.getPageCount();
    if (result.pages.length < expectedPages * 0.5 && expectedPages > 4) {
      logger.warn('Azure DI: Nur wenige Seiten zurück — vermutlich F0 Free Tier, wechsle zu Einzelseiten-Modus', {
        expected: expectedPages, got: result.pages.length,
      });
      finalResult = await analyzePerPage(pdfBuffer);
    } else {
      finalResult = result;
    }
  }

  saveToCache(cacheKey, finalResult);
  return finalResult;
}

async function analyzeSinglePdf(pdfBuffer: Buffer, pageOffset: number): Promise<OcrResult> {
  const endpoint = config.AZURE_DOC_INTEL_ENDPOINT!.replace(/\/$/, '');
  const apiKey = config.AZURE_DOC_INTEL_KEY!;

  // Submit for analysis — retry on 429
  const submitUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${API_VERSION}`;
  let submitRes: Response | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    submitRes = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/pdf',
      },
      body: pdfBuffer,
    });
    if (submitRes.status === 429) {
      const wait = Math.min(5000 * Math.pow(2, attempt), 30000);
      logger.warn(`Azure DI: Rate-Limit bei Submit, warte ${Math.round(wait / 1000)}s…`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    break;
  }

  if (!submitRes || !submitRes.ok) {
    const err = submitRes ? await submitRes.text() : 'no response';
    throw new Error(`Azure DI Analyse fehlgeschlagen (${submitRes?.status}): ${err.substring(0, 200)}`);
  }

  const operationLocation = submitRes.headers.get('operation-location');
  if (!operationLocation) {
    throw new Error('Azure DI: Keine Operation-Location im Response-Header');
  }

  // Poll for result
  for (let i = 0; i < MAX_POLL_RETRIES; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    });

    if (pollRes.status === 429) {
      logger.warn('Azure DI: Rate-Limit, warte 5s…');
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (!pollRes.ok) continue; // transient error, retry

    const result = await pollRes.json() as Record<string, unknown>;

    if (result.status === 'succeeded') {
      return parseAnalyzeResult(result, pageOffset);
    }

    if (result.status === 'failed') {
      throw new Error(`Azure DI Analyse fehlgeschlagen: ${JSON.stringify(result.error)}`);
    }
    // status is 'running' — continue polling
  }

  throw new Error('Azure DI: Timeout nach 3 Minuten');
}

function parseAnalyzeResult(result: Record<string, unknown>, pageOffset: number): OcrResult {
  const analyzeResult = result.analyzeResult as {
    content?: string;
    pages?: Array<{
      pageNumber: number;
      lines?: Array<{ content: string }>;
      words?: Array<{ content: string; confidence: number }>;
    }>;
    tables?: Array<{
      rowCount: number;
      columnCount: number;
      boundingRegions?: Array<{ pageNumber: number }>;
      cells: Array<{
        rowIndex: number;
        columnIndex: number;
        content: string;
        kind?: string;
      }>;
    }>;
  };

  // Build a map of tables per page
  const tablesPerPage = new Map<number, OcrTable[]>();
  for (const table of (analyzeResult?.tables || [])) {
    const pageNum = table.boundingRegions?.[0]?.pageNumber ?? 1;
    if (!tablesPerPage.has(pageNum)) tablesPerPage.set(pageNum, []);
    tablesPerPage.get(pageNum)!.push({
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      cells: table.cells.map(c => ({
        rowIndex: c.rowIndex,
        columnIndex: c.columnIndex,
        content: c.content,
        kind: c.kind,
      })),
    });
  }

  const pages: OcrPageResult[] = [];
  let totalChars = 0;

  for (const page of (analyzeResult?.pages || [])) {
    const lines = (page.lines || []).map(l => l.content);
    const text = lines.join('\n');
    totalChars += text.length;

    // Per-word confidence scores
    const wordConfidences: OcrWordConfidence[] = (page.words || []).map(w => ({
      text: w.content,
      confidence: w.confidence,
    }));

    const avgConfidence = wordConfidences.length > 0
      ? wordConfidences.reduce((sum, w) => sum + w.confidence, 0) / wordConfidences.length
      : 1.0;

    const lowConfidenceWords = wordConfidences.filter(w => w.confidence < 0.80);

    pages.push({
      pageNumber: page.pageNumber + pageOffset,
      text,
      lines,
      wordConfidences,
      avgConfidence,
      tables: tablesPerPage.get(page.pageNumber) || [],
      lowConfidenceWords,
    });
  }

  return { pages, totalChars };
}

/**
 * Split a large PDF into chunks ≤ 4MB and process each separately.
 * Uses pdf-lib to split by page ranges, finding the boundary where size fits.
 */
async function analyzeInChunks(pdfBuffer: Buffer): Promise<OcrResult> {
  const { PDFDocument } = await import('pdf-lib');
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  const allPages: OcrPageResult[] = [];
  let totalChars = 0;
  let startPage = 0;

  while (startPage < totalPages) {
    // Binary search for max endPage that fits in 4MB
    let lo = startPage;
    let hi = Math.min(startPage + totalPages, totalPages) - 1;
    let bestEnd = startPage; // at least one page

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const chunkDoc = await PDFDocument.create();
      const copied = await chunkDoc.copyPages(srcDoc, Array.from({ length: mid - startPage + 1 }, (_, i) => startPage + i));
      for (const page of copied) chunkDoc.addPage(page);
      const chunkBytes = await chunkDoc.save();

      if (chunkBytes.length <= MAX_PDF_SIZE) {
        bestEnd = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Extract the chunk
    const chunkDoc = await PDFDocument.create();
    const copied = await chunkDoc.copyPages(srcDoc, Array.from({ length: bestEnd - startPage + 1 }, (_, i) => startPage + i));
    for (const page of copied) chunkDoc.addPage(page);
    const chunkBuffer = Buffer.from(await chunkDoc.save());

    logger.info('Azure DI: OCR-Chunk', {
      pages: `${startPage + 1}-${bestEnd + 1}`,
      sizeKB: Math.round(chunkBuffer.length / 1024),
    });

    const chunkResult = await analyzeSinglePdf(chunkBuffer, startPage);
    for (const page of chunkResult.pages) {
      allPages.push(page);
    }
    totalChars += chunkResult.totalChars;

    startPage = bestEnd + 1;
  }

  return { pages: allPages, totalChars };
}

/**
 * Fallback for F0 free tier: process each page individually.
 * Slower due to rate limits, but works around the 2-page-per-document limit.
 */
async function analyzePerPage(pdfBuffer: Buffer): Promise<OcrResult> {
  const { PDFDocument } = await import('pdf-lib');
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  const allPages: OcrPageResult[] = [];
  let totalChars = 0;

  // Process in batches of 3 to balance speed vs rate limits
  const BATCH_SIZE = 3;
  for (let batch = 0; batch < totalPages; batch += BATCH_SIZE) {
    const batchPromises: Promise<OcrResult>[] = [];
    const batchPageNums: number[] = [];

    for (let p = batch; p < Math.min(batch + BATCH_SIZE, totalPages); p++) {
      const singleDoc = await PDFDocument.create();
      const [copied] = await singleDoc.copyPages(srcDoc, [p]);
      singleDoc.addPage(copied);
      const singleBuffer = Buffer.from(await singleDoc.save());
      batchPageNums.push(p + 1);
      batchPromises.push(analyzeSinglePdf(singleBuffer, p));
    }

    const batchResults = await Promise.all(batchPromises);
    for (const result of batchResults) {
      for (const page of result.pages) {
        allPages.push(page);
      }
      totalChars += result.totalChars;
    }

    if (batch + BATCH_SIZE < totalPages) {
      logger.info('Azure DI: Einzelseiten-Fortschritt', {
        done: Math.min(batch + BATCH_SIZE, totalPages),
        total: totalPages,
        chars: totalChars,
      });
      // Small delay between batches to respect rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  }

  logger.info('Azure DI: Einzelseiten-OCR abgeschlossen', { pages: allPages.length, totalChars });
  return { pages: allPages, totalChars };
}
