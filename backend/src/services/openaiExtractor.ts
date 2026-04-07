/**
 * OpenAI/GPT-5.4 extraction provider.
 * Uses native PDF file input — the API extracts text + renders page images automatically.
 * For large PDFs (>80 pages), chunks by document segments and merges results.
 */

import OpenAI from 'openai';
import { PDFDocument } from 'pdf-lib';
import { logger } from '../utils/logger';
import { extractionResultSchema } from '../utils/validation';
import type { ExtractionResult } from '../types/extraction';
import type { DocumentSegment } from '../utils/documentAnalyzer';

// Threshold: above this, chunk by segments to avoid 2x pricing (>272K tokens)
const CHUNK_PAGE_THRESHOLD = 80;

let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    const baseURL = process.env.OPENAI_BASE_URL;
    openaiClient = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), timeout: 600_000 });
  }
  return openaiClient;
}

/** Upload a PDF buffer as an OpenAI file and return the file ID */
async function uploadPdf(client: OpenAI, pdfBuffer: Buffer, name: string): Promise<string> {
  const file = await client.files.create({
    file: new File([pdfBuffer], name, { type: 'application/pdf' }),
    purpose: 'assistants',
  });
  return file.id;
}

/** Delete an uploaded file (cleanup) */
async function deleteFile(client: OpenAI, fileId: string): Promise<void> {
  try { await client.files.delete(fileId); } catch { /* ignore */ }
}

/** Extract a range of pages from a PDF buffer as a new PDF */
async function extractPdfPages(pdfBuffer: Buffer, pageIndices: number[]): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const newDoc = await PDFDocument.create();
  const copied = await newDoc.copyPages(srcDoc, pageIndices);
  for (const page of copied) newDoc.addPage(page);
  return Buffer.from(await newDoc.save());
}

/** Call GPT with a PDF file and extraction prompt, return raw text */
async function callGptWithPdf(
  client: OpenAI,
  model: string,
  pdfBuffer: Buffer,
  pdfName: string,
  prompt: string,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // Upload PDF
  const fileId = await uploadPdf(client, pdfBuffer, pdfName);

  try {
    const response = await client.responses.create({
      model,
      input: [
        { role: 'user', content: [
          { type: 'input_file', file_id: fileId },
          { type: 'input_text', text: prompt },
        ]},
      ],
      text: { format: { type: 'text' } },
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as string) || 'high' },
      max_output_tokens: 32000,
    } as Parameters<typeof client.responses.create>[0]);

    const text = response.output_text || '';
    const usage = response.usage;

    return {
      text,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    };
  } finally {
    await deleteFile(client, fileId);
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

/**
 * Extract data from PDF using OpenAI GPT-5.4 with native PDF input.
 * For small PDFs (≤80 pages): single call with full PDF.
 * For large PDFs (>80 pages): chunk by document segments, merge results.
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

  if (pageCount <= CHUNK_PAGE_THRESHOLD) {
    // Single call with full PDF
    logger.info('OpenAI extraction: single PDF call', { model, pages: pageCount });
    const startTime = Date.now();

    const { text, inputTokens, outputTokens } = await callGptWithPdf(
      client, model, pdfBuffer, 'gerichtsakte.pdf', prompt
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

      if (currentChunk.length + segPages.length > 70 && currentChunk.length > 0) {
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
    // Fixed-size chunks of 60 pages
    for (let i = 0; i < pageCount; i += 60) {
      const end = Math.min(i + 60, pageCount);
      const pages = Array.from({ length: end - i }, (_, j) => i + j);
      chunks.push({ name: `pages_${i + 1}-${end}`, pages });
    }
  }

  logger.info('OpenAI chunked extraction', { chunks: chunks.length, chunkSizes: chunks.map(c => c.pages.length) });

  // Extract each chunk
  let mergedResult: ExtractionResult | null = null;

  for (const chunk of chunks) {
    try {
      const chunkPdf = await extractPdfPages(pdfBuffer, chunk.pages);
      const chunkPrompt = prompt + `\n\nDieses PDF enthält die Seiten ${chunk.pages[0] + 1}-${chunk.pages[chunk.pages.length - 1] + 1} der Gesamtakte. Extrahiere ALLE Informationen die auf diesen Seiten zu finden sind.`;

      const { text, inputTokens, outputTokens } = await callGptWithPdf(
        client, model, chunkPdf, `chunk_${chunk.name}.pdf`, chunkPrompt
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
