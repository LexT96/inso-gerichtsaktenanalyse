/**
 * OpenAI/GPT-5.4 extraction provider.
 * Alternative to Claude for Stage 2 extraction.
 * Converts PDF pages to images and sends via vision API.
 */

import OpenAI from 'openai';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';
import { extractionResultSchema } from '../utils/validation';
import type { ExtractionResult } from '../types/extraction';

// Lazy-init OpenAI client
let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    const baseURL = process.env.OPENAI_BASE_URL;
    openaiClient = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });
  }
  return openaiClient;
}

/** Convert PDF buffer to array of base64 JPEG images using pymupdf */
async function pdfToImages(pdfBuffer: Buffer, dpi = 150, maxPages = 50): Promise<string[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-images-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    // Python script as a safe string argument to python3
    const script = `
import fitz, sys, os
doc = fitz.open(sys.argv[1])
out_dir = sys.argv[2]
max_p = int(sys.argv[3])
dpi_val = int(sys.argv[4])
for i in range(min(len(doc), max_p)):
    pix = doc[i].get_pixmap(dpi=dpi_val)
    pix.save(os.path.join(out_dir, f'page_{i:04d}.jpg'))
doc.close()
print(min(len(doc), max_p))
`;
    execFileSync('python3', ['-c', script, pdfPath, tmpDir, String(maxPages), String(dpi)], { timeout: 60000 });

    const images: string[] = [];
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort();
    for (const file of files) {
      const imgBuffer = fs.readFileSync(path.join(tmpDir, file));
      images.push(imgBuffer.toString('base64'));
    }

    logger.info('PDF converted to images', { pages: images.length, dpi });
    return images;
  } finally {
    try {
      for (const file of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, file));
      fs.rmdirSync(tmpDir);
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Extract data from PDF using OpenAI GPT-5.4 vision.
 * Drop-in replacement for extractComprehensive().
 */
export async function extractWithOpenAI(
  pdfBuffer: Buffer,
  _pageTexts: string[],
  extractionPrompt: string,
  documentMap?: string
): Promise<ExtractionResult> {
  const client = getOpenAI();
  const model = process.env.OPENAI_MODEL || 'gpt-5.4';

  const images = await pdfToImages(pdfBuffer, 150, 50);

  const content: OpenAI.Chat.ChatCompletionContentPart[] = [
    { type: 'text', text: extractionPrompt + (documentMap ? `\n\nDOKUMENTSTRUKTUR:\n${documentMap}` : '') },
  ];

  for (const b64 of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' },
    });
  }

  logger.info('Starting OpenAI extraction', { model, pages: images.length });
  const startTime = Date.now();

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content }],
    max_completion_tokens: 32000,
    temperature: 0,
  });

  const elapsed = Date.now() - startTime;
  const text = response.choices[0]?.message?.content || '';
  const usage = response.usage;

  logger.info('OpenAI extraction completed', {
    model,
    elapsed: `${(elapsed / 1000).toFixed(1)}s`,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  });

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.error('OpenAI extraction: no JSON in response', { preview: text.slice(0, 300) });
    throw new Error('OpenAI extraction returned no valid JSON');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    const { jsonrepair } = await import('jsonrepair');
    parsed = JSON.parse(jsonrepair(jsonMatch[0]));
  }

  const validated = extractionResultSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn('OpenAI extraction validation issues', { errors: validated.error.issues.length });
    return extractionResultSchema.parse(parsed) as unknown as ExtractionResult;
  }
  return validated.data as unknown as ExtractionResult;
}

/** Check if OpenAI is configured as extraction provider */
export function isOpenAIConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) && process.env.EXTRACTION_PROVIDER === 'openai';
}
