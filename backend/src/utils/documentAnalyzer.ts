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
import { callWithRetry, createAnthropicMessage } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import type { SegmentSourceType, FieldPackDefinition } from '../types/extraction';

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

/**
 * Classify document segments by extraction domain.
 * Returns page numbers relevant for each focused extractor.
 * Pages can appear in multiple domains (e.g. a page with both creditor and asset info).
 */
export interface ExtractionRouting {
  /** Pages relevant for forderungen/creditor extraction */
  forderungenPages: number[];
  /** Pages relevant for aktiva/asset extraction */
  aktivaPages: number[];
  /** Pages relevant for anfechtung/contestable transactions */
  anfechtungPages: number[];
}

// Keywords in segment type or description that indicate domain relevance
const FORDERUNGEN_KEYWORDS = /forderung|gläubiger|glaub|kredit|verbindlich|darlehen|wandel|schuld|sozialversicherung|finanzamt|steuer|arbeitnehmer|lohn|gehalt|insolvenzantrag|antragsteller|tabelle|passiva/i;
const AKTIVA_KEYWORDS = /aktiva|vermögen|bilanz|grundbuch|grundstück|immobili|fahrzeug|kfz|pkw|konto|bank|guthaben|versicherung|forderung.*schuldner|inventar|anlage|sachlage|vorräte|geschäftsausstattung|maschine|wertpapier/i;
const ANFECHTUNG_KEYWORDS = /anfechtung|zahlung|überweisung|transaktion|schenkung|gesellschafterdarlehen|nahestehend|§\s*1[3-4]\d|vorsätzlich|unentgeltlich|deckung|kongruent|inkongruent/i;

export function classifySegmentsForExtraction(
  segments: DocumentSegment[],
  totalPages: number,
): ExtractionRouting {
  const allPages = Array.from({ length: totalPages }, (_, i) => i + 1);

  // Token budget: ~2.5 chars/token for German, 200K limit minus ~10K for prompt/output.
  // If all pages fit, use all pages (no routing needed — preserves original behavior).
  const forderungenPages = new Set<number>();
  const aktivaPages = new Set<number>();
  const anfechtungPages = new Set<number>();

  for (const seg of segments) {
    const text = `${seg.type} ${seg.description}`.toLowerCase();
    if (FORDERUNGEN_KEYWORDS.test(text)) {
      for (const p of seg.pages) forderungenPages.add(p);
    }
    if (AKTIVA_KEYWORDS.test(text)) {
      for (const p of seg.pages) aktivaPages.add(p);
    }
    if (ANFECHTUNG_KEYWORDS.test(text)) {
      for (const p of seg.pages) anfechtungPages.add(p);
    }
  }

  // Fallback: if no pages matched for a domain, use all pages
  return {
    forderungenPages: forderungenPages.size > 0 ? [...forderungenPages].sort((a, b) => a - b) : allPages,
    aktivaPages: aktivaPages.size > 0 ? [...aktivaPages].sort((a, b) => a - b) : allPages,
    anfechtungPages: anfechtungPages.size > 0 ? [...anfechtungPages].sort((a, b) => a - b) : allPages,
  };
}

// ─── Segment Source Type Classification ───

// Keyword maps from segment type/description to SegmentSourceType
// Checked in order — first match wins.
const SOURCE_TYPE_PATTERNS: Array<{ pattern: RegExp; sourceType: SegmentSourceType }> = [
  { pattern: /beschluss/i, sourceType: 'beschluss' },
  { pattern: /insolvenzantrag|eigenantrag|fremdantrag/i, sourceType: 'insolvenzantrag' },
  { pattern: /zustellungsvermerk|pzu|postzustellungsurkunde/i, sourceType: 'pzu' },
  { pattern: /handelsregister|hr-auszug|hrauszug|hrb|hra|registerauszug/i, sourceType: 'handelsregister' },
  { pattern: /meldeauskunft|meldebescheinigung|einwohnermeldeamt/i, sourceType: 'meldeauskunft' },
  { pattern: /fragebogen|selbstauskunft/i, sourceType: 'fragebogen' },
  { pattern: /grundbuch|grundstück|grundbuchauszug/i, sourceType: 'grundbuch' },
  { pattern: /gerichtsvollzieher|gv-|vollstreckungsauftrag|pfändung/i, sourceType: 'gerichtsvollzieher' },
  { pattern: /vollstreckungsportal|schuldnerverzeichnis/i, sourceType: 'vollstreckungsportal' },
  { pattern: /forderungstabelle|gläubigertabelle|tabelle/i, sourceType: 'forderungstabelle' },
  { pattern: /vermögensverzeichnis|vermögensübersicht/i, sourceType: 'vermoegensverzeichnis' },
  { pattern: /gutachterbestellung|bestellung.*gutachter|gutachter.*bestellung/i, sourceType: 'gutachterbestellung' },
];

/**
 * Classify a DocumentSegment into a SegmentSourceType based on keyword matching
 * on both `type` and `description`. Defaults to 'sonstiges' if no pattern matches.
 */
export function classifySegmentSourceType(segment: DocumentSegment): SegmentSourceType {
  const text = `${segment.type} ${segment.description}`;
  for (const { pattern, sourceType } of SOURCE_TYPE_PATTERNS) {
    if (pattern.test(text)) return sourceType;
  }
  return 'sonstiges';
}

// ─── Field Pack Routing ───

export interface FieldPackRouting {
  [packId: string]: {
    pages: number[];
    segmentTypes: SegmentSourceType[];
  };
}

/**
 * Route document segments to field packs based on their source type.
 *
 * For each FieldPackDefinition:
 * 1. Classify every segment to a SegmentSourceType.
 * 2. Collect pages from segments whose type matches any of the pack's segmentTypes.
 * 3. If no pages match and fallbackPages is set, use fallback pages.
 * 4. Cap the result at maxPages.
 *
 * Returns a Record keyed by pack id.
 */
export function routeSegmentsToFieldPacks(
  segments: DocumentSegment[],
  totalPages: number,
  packDefinitions: FieldPackDefinition[],
): FieldPackRouting {
  const routing: FieldPackRouting = {};

  for (const pack of packDefinitions) {
    const targetTypes = new Set<SegmentSourceType>(pack.segmentTypes);
    const matchedPages = new Set<number>();
    const matchedSourceTypes: SegmentSourceType[] = [];

    for (const segment of segments) {
      const sourceType = classifySegmentSourceType(segment);
      if (targetTypes.has(sourceType)) {
        if (!matchedSourceTypes.includes(sourceType)) {
          matchedSourceTypes.push(sourceType);
        }
        for (const p of segment.pages) matchedPages.add(p);
      }
    }

    let pages: number[];
    if (matchedPages.size > 0) {
      pages = [...matchedPages].sort((a, b) => a - b);
    } else if (pack.fallbackPages === 'first_8') {
      const end = Math.min(8, totalPages);
      pages = Array.from({ length: end }, (_, i) => i + 1);
    } else if (pack.fallbackPages === 'all') {
      pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    } else {
      pages = [];
    }

    // Cap at maxPages
    if (pages.length > pack.maxPages) {
      pages = pages.slice(0, pack.maxPages);
    }

    routing[pack.id] = { pages, segmentTypes: matchedSourceTypes };
  }

  return routing;
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
  const dynamicContent = `--- AKTENINHALT (${pageTexts.length} Seiten) ---\n\n${pageBlock}`;

  try {
    const response = await callWithRetry(() =>
      createAnthropicMessage({
        model: config.UTILITY_MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user' as const, content: dynamicContent }],
      }, ANALYSIS_PROMPT)
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
