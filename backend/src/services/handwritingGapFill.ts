/**
 * Handwriting Gap-Fill Pass (Sprint 1).
 *
 * After the main multi-field handwriting pass has merged whatever it could
 * find, iterate the registry's critical fields. For each critical field still
 * empty on result.schuldner, send a FOCUSED single-field probe to Claude
 * (same images, but a narrow prompt from buildProbePrompt). Merge any value
 * that comes back via the same fill-only-empty rule the main pass uses.
 *
 * Why this works: the multi-field main prompt suffers attention dilution —
 * verified by probe-betriebsstaette.ts finding the Geldt-CNC betriebsstätte
 * in 5s with a single-field prompt after the main pass missed it for both
 * Sonnet 4.6 and Opus 4.6. Same Claude, same image — just focused attention.
 */

import type { ExtractionResult } from '../types/extraction';
import { HANDWRITING_FIELDS, buildProbePrompt, type HandwritingFieldDef } from '../utils/handwritingFieldRegistry';
import { createAnthropicMessage, extractJsonFromText } from './anthropic';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface GapFillInput {
  result: ExtractionResult;
  /** Page indices (0-based) of all Fragebogen pages — same set as the main pass */
  pageIndices: number[];
  /** Rendered JPEGs, same map the main pass already built */
  imagesByPage: Map<number, string>;
}

export interface GapFillOutcome {
  probesSent: number;
  probesFailed: number;
  gapsFilled: number;
  durationMs: number;
}

/** Field-path resolver on result.schuldner.<key>. Returns { wert, quelle } or undefined. */
function getSchuldnerField(
  result: ExtractionResult,
  key: string,
): { wert: unknown; quelle: string } | undefined {
  const s = result.schuldner as unknown as Record<string, { wert: unknown; quelle: string } | undefined>;
  return s[key];
}

function isEmpty(target: { wert: unknown } | undefined): boolean {
  if (!target) return true;
  const w = target.wert;
  return w === null || w === undefined || (typeof w === 'string' && w.trim() === '');
}

async function probeField(
  field: HandwritingFieldDef,
  pageIndices: number[],
  imagesByPage: Map<number, string>,
): Promise<{ wert: unknown; quelle: string } | null> {
  type Block =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };
  const content: Block[] = [];
  for (const p of pageIndices) {
    const b64 = imagesByPage.get(p);
    if (!b64) continue;
    content.push({ type: 'text', text: `=== SEITE ${p + 1} ===` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
  }
  if (content.length === 0) return null;
  content.push({ type: 'text', text: buildProbePrompt(field) });

  const response = await createAnthropicMessage({
    model: config.EXTRACTION_MODEL,
    max_tokens: 1024,
    temperature: 0,
    messages: [{ role: 'user' as const, content: content as never }],
  });

  const text = response.content
    .filter(c => c.type === 'text')
    .map(c => (c as { text: string }).text)
    .join('');
  try {
    const jsonStr = extractJsonFromText(text);
    const parsed = JSON.parse(jsonStr) as Record<string, { wert: unknown; quelle: string } | null>;
    const entry = parsed[field.key];
    if (!entry || entry.wert === null || entry.wert === undefined) return null;
    const wertStr = String(entry.wert).trim();
    if (!wertStr) return null;
    return { wert: wertStr, quelle: String(entry.quelle ?? '') };
  } catch (err) {
    logger.warn('Gap-fill probe JSON parse failed', {
      field: field.key,
      error: err instanceof Error ? err.message : String(err),
      sample: text.slice(0, 200),
    });
    return null;
  }
}

/**
 * Run the gap-fill pass. For each critical registry field that is still empty
 * on result.schuldner, dispatch a focused single-field probe to Claude using
 * the pre-rendered Fragebogen images, and merge any value that comes back.
 */
export async function runHandwritingGapFill(input: GapFillInput): Promise<GapFillOutcome> {
  const start = Date.now();
  let probesSent = 0;
  let probesFailed = 0;
  let gapsFilled = 0;

  for (const field of HANDWRITING_FIELDS) {
    if (field.criticality !== 'critical') continue;
    const target = getSchuldnerField(input.result, field.key);
    if (!isEmpty(target)) continue; // already has a value — skip

    probesSent++;
    try {
      const found = await probeField(field, input.pageIndices, input.imagesByPage);
      if (found && target) {
        target.wert = found.wert as never;
        target.quelle = `${found.quelle} (Handschrift-Gap-Fill)`;
        gapsFilled++;
      }
    } catch (err) {
      probesFailed++;
      logger.warn('Gap-fill probe call failed', {
        field: field.key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durationMs = Date.now() - start;
  logger.info('Handwriting gap-fill pass completed', {
    probesSent,
    probesFailed,
    gapsFilled,
    durationMs,
  });
  return { probesSent, probesFailed, gapsFilled, durationMs };
}
