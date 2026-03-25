/**
 * Document structure analysis — Stage 1 of the extraction pipeline.
 *
 * Produces a text description of the document structure (which pages
 * contain which document types) that feeds into both the extraction
 * and verification stages as context.
 *
 * Also parses the text map into structured segments for document-aware
 * chunking in Stage 2.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, callWithRetry } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';

// ─── Types ───

export interface DocumentSegment {
  type: string;
  pages: number[];
  description: string;
}

export interface DocumentAnalysis {
  /** Raw text map (fed into prompts as STRUKTURÜBERSICHT) */
  mapText: string;
  /** Parsed segments for document-aware chunking */
  segments: DocumentSegment[];
}

// ─── Prompt ───

const ANALYSIS_PROMPT = `Du analysierst eine deutsche Insolvenzakte und erstellst eine Dokumentstruktur-Übersicht.

Für jeden zusammenhängenden Abschnitt des Dokuments identifiziere:
1. Seitenbereich
2. Dokumenttyp (Beschluss, Insolvenzantrag, Zustellungsvermerk/PZU, Mitteilung des Gerichtsvollziehers, Grundbuchauskunft, Meldeauskunft, Schuldnerverzeichnis-Auskunft, Verfügung, Korrespondenz, etc.)
3. Wichtige Details des Abschnitts

Achte BESONDERS auf:
- Handschriftliche Einträge (z.B. Zustelldatum auf PZU — oft 1-3 Tage nach dem Beschlussdatum)
- Stellen wo Informationen ausdrücklich als "nicht bekannt" oder "nicht ermittelt" beschrieben werden und WELCHE konkrete Information betroffen ist
- Welche Adressen in welchem Kontext erscheinen (Privatanschrift vs. Betriebsstätte vs. Zustelladresse)
- Unterschiedliche Daten die leicht verwechselt werden können (Beschlussdatum, Antragsdatum, Zustelldatum)

Antworte NUR mit der strukturierten Liste, keine Einleitung:

DOKUMENTSTRUKTUR:
- Seiten X-Y: [Dokumenttyp] — [Wichtige Details, konkrete Werte wenn relevant]
- Seite Z: [Dokumenttyp] — [Details]
...`;

// ─── Page text preparation ───

// Document analysis only needs enough text per page to identify the document type.
// Truncating to ~500 chars keeps a 200-page document under 40k tokens,
// well within the 50k tokens/min rate limit.
const CHARS_PER_PAGE = 500;

function buildPageBlock(pageTexts: string[]): string {
  return pageTexts
    .map((text, i) => {
      const truncated = text.length > CHARS_PER_PAGE
        ? text.slice(0, CHARS_PER_PAGE) + ' [...]'
        : text;
      return `=== SEITE ${i + 1} ===\n${truncated}`;
    })
    .join('\n\n');
}

// ─── Document Map Parser ───

/**
 * Parse the text-based document map into structured segments.
 *
 * Handles formats like:
 *   - Seiten 1-3: Beschluss — Eröffnung, Az: 23 IN 165/25
 *   - Seite 9: Zustellungsvermerk — PZU, handschriftl. 03.01.2025
 *   - Seiten 10-12: Mitteilung des Gerichtsvollziehers — keine Vollstreckung möglich
 */
export function parseDocumentMap(mapText: string): DocumentSegment[] {
  if (!mapText) return [];

  const segments: DocumentSegment[] = [];
  const lines = mapText.split('\n');

  for (const line of lines) {
    // Match: "- Seite(n) X(-Y): Type — Description" or "- Seite(n) X(-Y): Type"
    const match = line.match(
      /^[-–•*]\s*Seiten?\s+([\d\s,\-–undbis]+):\s*(.+)$/i
    );
    if (!match) continue;

    const pageSpec = match[1];
    const rest = match[2].trim();

    // Parse page numbers (handles ranges, commas, "und", "bis")
    const pages: number[] = [];
    // Replace "bis" with dash (it's a range), "und" with comma (it's a separator)
    const parts = pageSpec.replace(/\bbis\b/gi, '-').replace(/\bund\b/gi, ',').split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const rangeMatch = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = start; i <= end; i++) pages.push(i);
      } else {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num)) pages.push(num);
      }
    }

    if (pages.length === 0) continue;

    // Split type and description on " — " or " - "
    // Only split on em-dash (—) or en-dash (–), not plain hyphen
    // which appears in German document type names like "Schuldnerverzeichnis-Auskunft"
    const separatorMatch = rest.match(/^(.+?)\s*[—–]\s+(.+)$/);
    const type = separatorMatch ? separatorMatch[1].trim() : rest;
    const description = separatorMatch ? separatorMatch[2].trim() : '';

    segments.push({ type, pages, description });
  }

  return segments;
}

/**
 * Find pages not covered by any segment (orphan pages).
 * Returns them grouped into contiguous ranges as generic segments.
 */
export function findOrphanPages(segments: DocumentSegment[], totalPages: number): DocumentSegment[] {
  const covered = new Set<number>();
  for (const seg of segments) {
    for (const p of seg.pages) covered.add(p);
  }

  const orphans: DocumentSegment[] = [];
  let rangeStart = -1;
  let rangePages: number[] = [];

  for (let p = 1; p <= totalPages; p++) {
    if (!covered.has(p)) {
      if (rangeStart === -1) rangeStart = p;
      rangePages.push(p);
    } else if (rangePages.length > 0) {
      orphans.push({ type: 'Sonstige Dokumente', pages: rangePages, description: '' });
      rangeStart = -1;
      rangePages = [];
    }
  }
  if (rangePages.length > 0) {
    orphans.push({ type: 'Sonstige Dokumente', pages: rangePages, description: '' });
  }

  return orphans;
}

// ─── Main ───

/**
 * Analyze document structure and produce both a text map and parsed segments.
 *
 * The text map feeds into prompts as STRUKTURÜBERSICHT.
 * The parsed segments enable document-aware chunking in Stage 2.
 *
 * On failure: logs warning, returns empty map and no segments (graceful degradation).
 */
export async function analyzeDocumentStructure(pageTexts: string[]): Promise<DocumentAnalysis> {
  if (pageTexts.length === 0) return { mapText: '', segments: [] };

  const pageBlock = buildPageBlock(pageTexts);
  const content = `${ANALYSIS_PROMPT}\n\n--- AKTENINHALT (${pageTexts.length} Seiten) ---\n\n${pageBlock}`;

  try {
    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model: config.UTILITY_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    const mapText = text.trim();
    const segments = parseDocumentMap(mapText);

    // Include orphan pages so nothing is missed
    const orphans = findOrphanPages(segments, pageTexts.length);
    const allSegments = [...segments, ...orphans];

    logger.info('Dokumentstruktur analysiert', {
      pages: pageTexts.length,
      mapLength: mapText.length,
      segments: segments.length,
      orphanSegments: orphans.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    return { mapText, segments: allSegments };
  } catch (err) {
    logger.warn('Dokumentstruktur-Analyse fehlgeschlagen — übersprungen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { mapText: '', segments: [] };
  }
}
