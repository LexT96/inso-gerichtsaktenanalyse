/**
 * OpenAI/GPT-5.4 extraction provider.
 * Uses native PDF file input — the API extracts text + renders page images automatically.
 * For large PDFs (>80 pages), chunks by document segments and merges results.
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PDFDocument } from 'pdf-lib';
import { logger } from '../utils/logger';
import { extractionResultSchema } from '../utils/validation';
import type { ExtractionResult } from '../types/extraction';
import type { DocumentSegment } from '../utils/documentAnalyzer';

// Langdock detection
const IS_LANGDOCK = Boolean(process.env.OPENAI_BASE_URL?.includes('langdock'));
// Langdock: use 100 DPI (1100 tokens/page) → 50 pages fit in 60K TPM
// Direct: use 150 DPI (2700 tokens/page) → 80 pages fit in 1M context
const IMAGE_DPI = IS_LANGDOCK ? 100 : 150;
const CHUNK_PAGE_THRESHOLD = IS_LANGDOCK ? 50 : 80;

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const baseURL = process.env.OPENAI_BASE_URL;
    openaiClient = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      timeout: 600_000,
      maxRetries: IS_LANGDOCK ? 3 : 2, // Retry on 429 with exponential backoff
    });
  }
  return openaiClient;
}

/** Extract a range of pages from a PDF buffer as a new PDF */
async function extractPdfPages(pdfBuffer: Buffer, pageIndices: number[]): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const newDoc = await PDFDocument.create();
  const copied = await newDoc.copyPages(srcDoc, pageIndices);
  for (const page of copied) newDoc.addPage(page);
  return Buffer.from(await newDoc.save());
}

/** Call GPT with PDF pages as images via Chat Completions API.
 *  pageNumberOffset: 1-based page number of the first image (for correct quelle references) */
async function callGptWithImages(
  client: OpenAI,
  model: string,
  pdfBuffer: Buffer,
  maxPages: number,
  prompt: string,
  pageNumberOffset = 1,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { execFileSync } = await import('child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-img-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    // Convert PDF to JPEG via pymupdf
    const script = `
import fitz, sys, os
doc = fitz.open(sys.argv[1])
for i in range(min(len(doc), int(sys.argv[3]))):
    pix = doc[i].get_pixmap(dpi=int(sys.argv[4]))
    pix.save(os.path.join(sys.argv[2], f'page_{i:04d}.jpg'))
doc.close()
`;
    execFileSync('python3', ['-c', script, pdfPath, tmpDir, String(maxPages), String(IMAGE_DPI)], { timeout: 60000 });

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: prompt },
    ];

    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort();
    for (let idx = 0; idx < files.length; idx++) {
      const pageNum = pageNumberOffset + idx;
      // Label each image with its authoritative PDF page number
      content.push({ type: 'text', text: `=== SEITE ${pageNum} === Verwende genau "Seite ${pageNum}, ..." für Fundstellen aus dem folgenden Bild.` });
      const b64 = fs.readFileSync(path.join(tmpDir, files[idx])).toString('base64');
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } });
    }

    logger.info('Sending images to GPT', { pages: files.length, model });

    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content }],
      max_completion_tokens: 32000,
    });

    const text = response.choices[0]?.message?.content || '';
    const usage = response.usage;

    return {
      text,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    };
  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  }
}

/** Parse JSON from GPT response text */
async function parseJsonResponse(text: string): Promise<unknown> {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in OpenAI response');

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    const { jsonrepair } = await import('jsonrepair');
    return JSON.parse(jsonrepair(jsonMatch[0]));
  }
}

/** Validate parsed JSON through our Zod schema */
function validateResult(parsed: unknown): ExtractionResult {
  const validated = extractionResultSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn('OpenAI extraction validation issues', { errors: validated.error.issues.length });
    return extractionResultSchema.parse(parsed) as unknown as ExtractionResult;
  }
  return validated.data as unknown as ExtractionResult;
}

/** Merge two ExtractionResults — second fills gaps in first */
function mergeResults(base: ExtractionResult, addition: ExtractionResult): ExtractionResult {
  const merged = { ...base };

  // Merge schuldner fields
  if (addition.schuldner) {
    const baseS = merged.schuldner as unknown as Record<string, unknown>;
    for (const [key, val] of Object.entries(addition.schuldner as unknown as Record<string, unknown>)) {
      if (val && typeof val === 'object' && 'wert' in val) {
        const sv = val as { wert: unknown };
        const bv = baseS[key] as { wert: unknown } | undefined;
        if (sv.wert != null && sv.wert !== '' && (!bv || bv.wert == null || bv.wert === '')) {
          baseS[key] = val;
        }
      }
    }
  }

  // Merge verfahrensdaten
  if (addition.verfahrensdaten) {
    const baseV = merged.verfahrensdaten as unknown as Record<string, unknown>;
    for (const [key, val] of Object.entries(addition.verfahrensdaten as unknown as Record<string, unknown>)) {
      if (val && typeof val === 'object' && 'wert' in val) {
        const sv = val as { wert: unknown };
        const bv = baseV[key] as { wert: unknown } | undefined;
        if (sv.wert != null && sv.wert !== '' && (!bv || bv.wert == null || bv.wert === '')) {
          baseV[key] = val;
        }
      }
    }
  }

  // Merge einzelforderungen (deduplicate by glaeubiger+betrag)
  if (addition.forderungen?.einzelforderungen?.length) {
    const existing = new Set(
      (merged.forderungen?.einzelforderungen ?? []).map(f =>
        `${f.glaeubiger?.wert}|${f.betrag?.wert}`
      )
    );
    for (const ef of addition.forderungen.einzelforderungen) {
      const key = `${ef.glaeubiger?.wert}|${ef.betrag?.wert}`;
      if (!existing.has(key)) {
        merged.forderungen.einzelforderungen.push(ef);
        existing.add(key);
      }
    }
  }

  // Merge aktiva
  if (addition.aktiva?.positionen?.length) {
    const existing = new Set(
      (merged.aktiva?.positionen ?? []).map(p => p.beschreibung?.wert)
    );
    for (const pos of addition.aktiva.positionen) {
      if (!existing.has(pos.beschreibung?.wert)) {
        merged.aktiva!.positionen.push(pos);
      }
    }
  }

  return merged;
}

// ─── Hybrid mode: text for all pages + images for key pages only ───
// Fits 200+ pages under 60K TPM. Used when IS_LANGDOCK and pages > CHUNK_PAGE_THRESHOLD.

const KEY_PAGE_MARKERS = [
  /beschluss/i, /fragebogen/i, /anlage/i, /ergänzungsblatt/i,
  /vermögensübersicht/i, /schuldenaufstellung/i, /aufstellung der schulden/i,
  /gläubiger.*verzeichnis/i, /leistungsbescheid/i, /zustellungsurkunde/i,
  /grundbuch/i, /vollstreckungsportal/i, /meldeauskunft/i,
  /handelsregister/i, /kontierung/i, /buchung/i, /bilanz/i, /bwa/i,
];

function detectKeyPages(pageTexts: string[], maxImages = 20): number[] {
  const keyPages: number[] = [];

  // Always include first 3 pages (cover, Beschluss, overview)
  for (let i = 0; i < Math.min(3, pageTexts.length); i++) keyPages.push(i);

  // Include pages matching key document markers
  for (let i = 0; i < pageTexts.length; i++) {
    if (keyPages.includes(i)) continue;
    const text = pageTexts[i].toLowerCase();
    if (KEY_PAGE_MARKERS.some(m => m.test(text))) {
      keyPages.push(i);
    }
  }

  // Cap at maxImages
  return keyPages.sort((a, b) => a - b).slice(0, maxImages);
}

async function callGptHybrid(
  client: OpenAI,
  model: string,
  pdfBuffer: Buffer,
  pageTexts: string[],
  keyPageIndices: number[],
  prompt: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const { execFileSync } = await import('child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-img-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    // Convert only key pages to JPEG
    const pageList = keyPageIndices.join(',');
    const script = `
import fitz, sys, os
doc = fitz.open(sys.argv[1])
pages = [int(p) for p in sys.argv[4].split(',') if p]
for i in pages:
    if i < len(doc):
        pix = doc[i].get_pixmap(dpi=int(sys.argv[3]))
        pix.save(os.path.join(sys.argv[2], f'page_{i:04d}.jpg'))
doc.close()
`;
    execFileSync('python3', ['-c', script, pdfPath, tmpDir, String(IMAGE_DPI), pageList], { timeout: 60000 });

    // Build content: prompt + full text + selective images
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: prompt },
    ];

    // Add ALL pages as text
    const textBlock = pageTexts.map((t, i) =>
      `=== SEITE ${i + 1} ===\n${t}`
    ).join('\n\n');
    content.push({ type: 'text', text: `\n\n--- VOLLSTÄNDIGER AKTENINHALT (${pageTexts.length} Seiten) ---\n\n${textBlock}` });

    // Add key pages as images for visual detail (forms, handwriting, tables)
    content.push({ type: 'text', text: '\n\n--- BILDANSICHT WICHTIGER SEITEN (für Handschrift, Tabellen, Formulare) ---' });

    const keyPageSet = new Set(keyPageIndices);
    const imgFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort();
    for (const file of imgFiles) {
      const pageIdx = parseInt(file.replace('page_', '').replace('.jpg', ''), 10);
      const pageNum = pageIdx + 1;
      content.push({ type: 'text', text: `=== BILD SEITE ${pageNum} ===` });
      const b64 = fs.readFileSync(path.join(tmpDir, file)).toString('base64');
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } });
    }

    logger.info('Sending hybrid (text + images) to GPT', {
      model, totalPages: pageTexts.length, imagePages: keyPageIndices.length,
      keyPages: keyPageIndices.map(i => i + 1),
    });

    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content }],
      max_completion_tokens: 32000,
    });

    const text = response.choices[0]?.message?.content || '';
    return {
      text,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    };
  } finally {
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }
  }
}

/**
 * Extract data from PDF using OpenAI GPT-5.4.
 * Strategy depends on provider:
 * - Direct OpenAI: all pages as images (high DPI)
 * - Langdock (≤50 pages): all pages as images (100 DPI)
 * - Langdock (>50 pages): hybrid text + selective images
 */
export async function extractWithOpenAI(
  pdfBuffer: Buffer,
  pageTexts: string[],
  extractionPrompt: string,
  documentMap?: string,
  segments?: DocumentSegment[],
): Promise<ExtractionResult> {
  const client = getOpenAI();
  const model = process.env.OPENAI_MODEL || 'gpt-5.4';
  const pageCount = pageTexts.length;
  const prompt = extractionPrompt + (documentMap ? `\n\nDOKUMENTSTRUKTUR:\n${documentMap}` : '');

  // Langdock large docs: hybrid mode (text + selective images)
  if (IS_LANGDOCK && pageCount > CHUNK_PAGE_THRESHOLD) {
    logger.info('OpenAI extraction: hybrid mode (text + key images)', { model, pages: pageCount });
    const startTime = Date.now();
    // Budget: 60K TPM. Text ~200 tok/page. Images ~1100 tok/page at 100 DPI.
    // 182 pages text = 36K. Remaining for images: (60K - 36K - 5K prompt) / 1100 = ~17 images
    const maxImages = Math.max(5, Math.floor((55000 - pageCount * 200) / 1100));
    const keyPages = detectKeyPages(pageTexts, maxImages);
    logger.info('Hybrid budget', { pageCount, maxImages, selectedImages: keyPages.length });

    const { text, inputTokens, outputTokens } = await callGptHybrid(
      client, model, pdfBuffer, pageTexts, keyPages, prompt
    );

    logger.info('OpenAI hybrid extraction completed', {
      model, pages: pageCount, keyImages: keyPages.length,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      inputTokens, outputTokens,
    });

    const parsed = await parseJsonResponse(text);
    return validateResult(parsed);
  }

  if (pageCount <= CHUNK_PAGE_THRESHOLD) {
    // Single call with all pages as images
    logger.info('OpenAI extraction: single PDF call', { model, pages: pageCount, dpi: IMAGE_DPI });
    const startTime = Date.now();

    const { text, inputTokens, outputTokens } = await callGptWithImages(
      client, model, pdfBuffer, CHUNK_PAGE_THRESHOLD, prompt
    );

    logger.info('OpenAI extraction completed', {
      model, pages: pageCount,
      elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
      inputTokens, outputTokens,
    });

    const parsed = await parseJsonResponse(text);
    return validateResult(parsed);
  }

  // Large PDF: chunk by segments
  logger.info('OpenAI extraction: chunked mode', { model, pages: pageCount, segments: segments?.length ?? 0 });
  const startTime = Date.now();

  // Build chunks from segments or use fixed-size chunks
  const chunks: { name: string; pages: number[] }[] = [];

  if (segments && segments.length > 0) {
    // Group segments into chunks of ~60 pages each
    let currentChunk: number[] = [];
    let currentName = '';

    for (const seg of segments) {
      // seg.pages is 1-indexed array, convert to 0-indexed for pdf-lib
      const segPages = seg.pages.map(p => p - 1);

      if (currentChunk.length + segPages.length > CHUNK_PAGE_THRESHOLD && currentChunk.length > 0) {
        chunks.push({ name: currentName || `pages_${currentChunk[0] + 1}-${currentChunk[currentChunk.length - 1] + 1}`, pages: currentChunk });
        currentChunk = [];
        currentName = '';
      }

      currentChunk.push(...segPages);
      currentName = currentName ? `${currentName}+${seg.type}` : seg.type;
    }

    if (currentChunk.length > 0) {
      chunks.push({ name: currentName || 'remainder', pages: currentChunk });
    }
  } else {
    // Fixed-size chunks respecting threshold
    const chunkSize = CHUNK_PAGE_THRESHOLD;
    for (let i = 0; i < pageCount; i += chunkSize) {
      const end = Math.min(i + chunkSize, pageCount);
      const pages = Array.from({ length: end - i }, (_, j) => i + j);
      chunks.push({ name: `pages_${i + 1}-${end}`, pages });
    }
  }

  logger.info('OpenAI chunked extraction', { chunks: chunks.length, chunkSizes: chunks.map(c => c.pages.length) });

  // Extract each chunk (serialize with delay for rate-limited providers)
  const isLangdock = Boolean(process.env.OPENAI_BASE_URL?.includes('langdock'));
  const RATE_LIMIT_DELAY = isLangdock ? 62_000 : 0; // 62s for Langdock 60K TPM
  let mergedResult: ExtractionResult | null = null;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    // Wait between chunks for rate-limited providers
    if (ci > 0 && RATE_LIMIT_DELAY > 0) {
      logger.info(`Rate limit delay: waiting ${RATE_LIMIT_DELAY / 1000}s before chunk ${ci + 1}`);
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
    }
    try {
      const chunkPdf = await extractPdfPages(pdfBuffer, chunk.pages);
      const chunkPrompt = prompt + `\n\nDieses PDF enthält die Seiten ${chunk.pages[0] + 1}-${chunk.pages[chunk.pages.length - 1] + 1} der Gesamtakte. Extrahiere ALLE Informationen die auf diesen Seiten zu finden sind.`;

      const chunkPageOffset = chunk.pages[0] + 1;
      const { text, inputTokens, outputTokens } = await callGptWithImages(
        client, model, chunkPdf, CHUNK_PAGE_THRESHOLD, chunkPrompt, chunkPageOffset
      );

      logger.info(`Chunk "${chunk.name}" completed`, { pages: chunk.pages.length, inputTokens, outputTokens });

      const parsed = await parseJsonResponse(text);
      const chunkResult = validateResult(parsed);

      mergedResult = mergedResult ? mergeResults(mergedResult, chunkResult) : chunkResult;
    } catch (err) {
      logger.warn(`Chunk "${chunk.name}" failed, continuing`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!mergedResult) throw new Error('All OpenAI extraction chunks failed');

  logger.info('OpenAI chunked extraction completed', {
    model, pages: pageCount, chunks: chunks.length,
    elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
  });

  return mergedResult;
}

/** Check if OpenAI is configured as extraction provider */
export function isOpenAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) && process.env.EXTRACTION_PROVIDER === 'openai';
}
