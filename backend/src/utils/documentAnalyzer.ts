/**
 * Document structure analysis — Stage 1 of the extraction pipeline.
 *
 * Produces a text description of the document structure (which pages
 * contain which document types) that feeds into both the extraction
 * and verification stages as context.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropic, callWithRetry } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';

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

// ─── Main ───

/**
 * Analyze document structure and produce a text map of sections.
 *
 * Returns a string like:
 *   DOKUMENTSTRUKTUR:
 *   - Seiten 1-3: Beschluss des AG Trier — Eröffnung vorläufiges Verfahren, Az: 23 IN 165/25
 *   - Seiten 4-8: Insolvenzantrag der HEK — Forderung: 12.345,67 EUR
 *   ...
 *
 * On failure: logs warning, returns empty string (graceful degradation).
 */
export async function analyzeDocumentStructure(pageTexts: string[]): Promise<string> {
  if (pageTexts.length === 0) return '';

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

    logger.info('Dokumentstruktur analysiert', {
      pages: pageTexts.length,
      mapLength: text.length,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    return text.trim();
  } catch (err) {
    logger.warn('Dokumentstruktur-Analyse fehlgeschlagen — übersprungen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}
