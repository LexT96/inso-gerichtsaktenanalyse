/**
 * Semantic page reference verification using Claude Haiku.
 *
 * Replaces the text-matching pageVerifier with a single API call that
 * understands document context and authoritative sources.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { logger } from './logger';
import type { ExtractionResult } from '../types/extraction';

// ─── Types ───

interface SourcedField {
  wert: unknown;
  quelle: string;
  verifiziert?: boolean;
}

interface CollectedField {
  ref: SourcedField;
  path: string;
}

interface VerificationEntry {
  nr: number;
  verifiziert: boolean;
  quelle_korrigiert?: string;
  begruendung?: string;
}

// ─── Field collection ───

function isSourcedField(obj: unknown): obj is SourcedField {
  if (obj === null || obj === undefined || typeof obj !== 'object') return false;
  return 'wert' in obj && 'quelle' in obj;
}

function wertIsEmpty(wert: unknown): boolean {
  if (wert === null || wert === undefined) return true;
  if (typeof wert === 'string') return wert.trim() === '';
  return false;
}

/**
 * Walk an ExtractionResult and collect all {wert, quelle} fields
 * that have non-empty wert values, along with their dot-notation paths.
 */
export function collectFields(obj: unknown, prefix: string = ''): CollectedField[] {
  const fields: CollectedField[] = [];

  if (obj === null || obj === undefined || typeof obj !== 'object') return fields;

  if (isSourcedField(obj)) {
    if (!wertIsEmpty(obj.wert)) {
      fields.push({ ref: obj, path: prefix });
    }
    return fields;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      fields.push(...collectFields(obj[i], `${prefix}[${i}]`));
    }
    return fields;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    fields.push(...collectFields(value, path));
  }

  return fields;
}

// ─── Prompt ───

const VERIFICATION_PROMPT = `Du prüfst extrahierte Daten aus einer deutschen Insolvenzakte.
Für jedes Feld prüfe:
1. Kommt der Wert tatsächlich im Dokument vor?
2. Ist die angegebene Seite korrekt?
3. Ist die Quelle die AUTORITATIVE Fundstelle — nicht bloß irgendeine Erwähnung?

Autoritative Quellen in Insolvenzakten:
- Verfahrensdaten (Aktenzeichen, Gericht, Richter, Beschlussdatum, Antragsart) → Beschluss/Verfügung des Gerichts
- Schuldnerdaten (Name, Adresse, Geburtsdatum, Firma) → Rubrum des Beschlusses oder Insolvenzantrag
- Antragstellerdaten (Name, Adresse, Forderungen) → Insolvenzantrag
- Forderungen (Beträge, Zeiträume) → Insolvenzantrag / Forderungsaufstellung
- Gutachterbestellung → Beschluss zur Gutachterbestellung
- Ermittlungsergebnisse Grundbuch → Grundbuchauskunft/-mitteilung
- Ermittlungsergebnisse Gerichtsvollzieher → Mitteilung des Gerichtsvollziehers
- Ermittlungsergebnisse Meldeauskunft → Meldebehördliche Auskunft
- Ermittlungsergebnisse Vollstreckungsportal → Schuldnerverzeichnis-Auskunft

WICHTIG: Ein Datum, Name oder Betrag kann auf mehreren Seiten vorkommen. Wähle die Seite, auf der der Wert in seinem FACHLICHEN KONTEXT steht — nicht die erste oder zufällige Erwähnung.

Zusätzliche Prüfungen:
- Wenn das Dokument eine Information ausdrücklich als unbekannt beschreibt ("ist mir nicht bekannt", "konnte nicht ermittelt werden"), der Wert aber trotzdem gesetzt wurde → verifiziert: false + begruendung "Dokument sagt ausdrücklich, dass diese Information nicht bekannt ist"
- betriebsstaette_adresse: Prüfe ob der Wert tatsächlich eine Betriebsstätte ist oder ob es die Privatanschrift (aktuelle_adresse) ist. Wenn der Gerichtsvollzieher sagt "Betriebsstätte nicht bekannt" und die Adresse identisch mit der Privatanschrift ist → verifiziert: false
- zustellungsdatum_schuldner: Das handschriftliche Datum des Postzustellers auf dem Zustellungsvermerk/PZU ist maßgeblich, nicht das Ausstellungsdatum des Beschlusses. Prüfe ob das korrekte Zustelldatum verwendet wurde.

Wenn der Wert im Dokument vorkommt und die Quelle korrekt ist → verifiziert: true
Wenn der Wert vorkommt, aber auf einer anderen Seite steht → verifiziert: true + quelle_korrigiert mit korrekter Seitenangabe
Wenn der Wert NICHT im Dokument vorkommt → verifiziert: false + begruendung
Wenn der Wert zwar im Dokument vorkommt, aber dem falschen Feld zugeordnet wurde → verifiziert: false + begruendung

Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Markdown, keine Erklärung):
[{"nr": 1, "verifiziert": true}, {"nr": 2, "verifiziert": true, "quelle_korrigiert": "Seite X, Beschluss"}, ...]`;

// ─── Token estimation ───

const MAX_ESTIMATED_TOKENS = 150_000;
const CHARS_PER_TOKEN = 3;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build page text block. If total tokens would exceed the limit,
 * truncate by keeping first and last pages.
 */
function buildPageBlock(pageTexts: string[]): string {
  const fullBlock = pageTexts
    .map((text, i) => `=== SEITE ${i + 1} ===\n${text}`)
    .join('\n\n');

  if (estimateTokens(fullBlock) <= MAX_ESTIMATED_TOKENS) {
    return fullBlock;
  }

  // Keep first 100 + last 100 pages
  const keepFront = 100;
  const keepBack = Math.max(0, Math.min(100, pageTexts.length - keepFront));
  const frontPages = pageTexts.slice(0, keepFront);
  const backPages = pageTexts.slice(pageTexts.length - keepBack);
  const omitted = pageTexts.length - keepFront - keepBack;

  logger.warn('Seitentext zu groß für Verifikation, Seiten in der Mitte werden übersprungen', {
    totalPages: pageTexts.length,
    omittedPages: omitted,
  });

  const frontBlock = frontPages
    .map((text, i) => `=== SEITE ${i + 1} ===\n${text}`)
    .join('\n\n');
  const backBlock = backPages
    .map((text, i) => `=== SEITE ${pageTexts.length - keepBack + i + 1} ===\n${text}`)
    .join('\n\n');

  return `${frontBlock}\n\n[... ${omitted} Seiten übersprungen ...]\n\n${backBlock}`;
}

function buildFieldList(fields: CollectedField[]): string {
  return fields
    .map((f, i) => {
      const wert = typeof f.ref.wert === 'string' ? f.ref.wert : String(f.ref.wert);
      return `${i + 1}. ${f.path} | Wert: "${wert}" | Quelle: "${f.ref.quelle}"`;
    })
    .join('\n');
}

// ─── Parse verification response ───

function parseVerificationResponse(text: string): VerificationEntry[] {
  const jsonStr = extractJsonFromText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(jsonStr));
      logger.info('Verifikations-JSON per jsonrepair repariert');
    } catch (err) {
      logger.error('Verifikations-JSON konnte nicht geparst werden', {
        error: err instanceof Error ? err.message : String(err),
        sample: jsonStr.slice(0, 300),
      });
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    logger.error('Verifikations-Antwort ist kein Array');
    return [];
  }

  return parsed.filter(
    (e): e is VerificationEntry =>
      e != null &&
      typeof e === 'object' &&
      typeof (e as VerificationEntry).nr === 'number' &&
      typeof (e as VerificationEntry).verifiziert === 'boolean'
  );
}

// ─── Main ───

/**
 * Semantically verify all page references in an ExtractionResult
 * using a single Claude Haiku API call.
 *
 * For each sourced field with a non-empty wert:
 * - If verified → verifiziert = true
 * - If wrong page → corrects quelle, verifiziert = true
 * - If value not in document → verifiziert = false
 *
 * On API failure: logs warning, returns result unchanged (graceful degradation).
 */
export async function semanticVerify(
  result: ExtractionResult,
  pageTexts: string[]
): Promise<ExtractionResult> {
  const fields = collectFields(result);

  if (fields.length === 0) {
    logger.info('Keine Felder zur Verifikation gefunden');
    return result;
  }

  const pageBlock = buildPageBlock(pageTexts);
  const fieldList = buildFieldList(fields);

  const content = `${VERIFICATION_PROMPT}

--- AKTENINHALT ---

${pageBlock}

--- EXTRAHIERTE FELDER (${fields.length} Stück) ---

${fieldList}`;

  try {
    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001' as const,
        max_tokens: 8192,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    const entries = parseVerificationResponse(text);

    if (response.stop_reason === 'max_tokens') {
      logger.warn('Verifikations-Antwort wurde abgeschnitten (max_tokens erreicht)', {
        entriesReceived: entries.length,
        fieldsTotal: fields.length,
      });
    }

    // Stage mutations first, then apply atomically to avoid partial state on error
    const mutations: Array<{ ref: SourcedField; verifiziert: boolean; quelle?: string }> = [];
    let verified = 0;
    let corrected = 0;
    let failed = 0;

    for (const entry of entries) {
      const idx = entry.nr - 1;
      if (idx < 0 || idx >= fields.length) continue;

      if (entry.verifiziert) {
        if (entry.quelle_korrigiert) {
          mutations.push({ ref: fields[idx].ref, verifiziert: true, quelle: entry.quelle_korrigiert });
          corrected++;
        } else {
          mutations.push({ ref: fields[idx].ref, verifiziert: true });
          verified++;
        }
      } else {
        mutations.push({ ref: fields[idx].ref, verifiziert: false });
        failed++;
      }
    }

    // Apply all mutations atomically
    for (const m of mutations) {
      m.ref.verifiziert = m.verifiziert;
      if (m.quelle !== undefined) {
        m.ref.quelle = m.quelle;
      }
    }

    const skipped = fields.length - mutations.length;

    logger.info('Semantische Verifikation abgeschlossen', {
      total: fields.length,
      verified,
      corrected,
      failed,
      skipped,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });
  } catch (err) {
    logger.warn('Semantische Verifikation fehlgeschlagen — übersprungen', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
