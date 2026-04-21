/**
 * Anchor extractor — Stage 0 of the fieldpack pipeline.
 *
 * Reads the first 5-8 pages of a court file and extracts core identifiers
 * (case number, court, debtor name/type, applicant, etc.). The result flows
 * into all subsequent extraction calls as stable context.
 *
 * Fast and cheap: small token budget, no extended thinking, utility model
 * class output. Errors produce a safe empty packet so the pipeline continues.
 */

import { jsonrepair } from 'jsonrepair';
import { createAnthropicMessage } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import type { AnchorPacket } from '../types/extraction';

// ─── System Prompt ───

const ANCHOR_SYSTEM_PROMPT = `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Deine Aufgabe ist es, aus den ersten Seiten einer Gerichtsakte die wichtigsten Identifikationsmerkmale zu extrahieren.

REGELN:
- Jeder Wert MUSS direkt aus dem Text stammen — keine Schätzungen, keine Annahmen
- Datumsformat: TT.MM.JJJJ (z.B. 18.12.2025)
- debtor_type-Bestimmung:
  - "juristische_person": GmbH, AG, UG, SE, eG, gGmbH, KGaA, e.V., Stiftung
  - "personengesellschaft": OHG, KG, GbR, PartG
  - "natuerliche_person": alles andere (Einzelperson, Einzelunternehmer, Freiberufler)
- debtor_canonical_name:
  - Natürliche Person: "Nachname, Vorname" (z.B. "Müller, Hans")
  - Juristische Person / Personengesellschaft: vollständiger Firmenname
- Fehlende Felder: null setzen (NICHT weglassen)
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks, keine Erklärungen

Antworte mit folgendem JSON-Schema:
{
  "aktenzeichen": "35 IN 42/26" | null,
  "gericht": "Amtsgericht Trier" | null,
  "beschlussdatum": "TT.MM.JJJJ" | null,
  "antragsdatum": "TT.MM.JJJJ" | null,
  "debtor_canonical_name": "Firmenname oder Nachname, Vorname" | null,
  "debtor_rechtsform": "GmbH" | null,
  "debtor_type": "natuerliche_person" | "juristische_person" | "personengesellschaft",
  "applicant_canonical_name": "Name des Antragstellers (Gläubiger der Antrag gestellt hat)" | null,
  "gutachter_name": "Name des bestellten Gutachters/Insolvenzverwalters" | null
}`;

// ─── Empty packet helper ───

function emptyAnchorPacket(): AnchorPacket {
  return {
    aktenzeichen: null,
    gericht: null,
    beschlussdatum: null,
    antragsdatum: null,
    debtor_canonical_name: null,
    debtor_rechtsform: null,
    debtor_type: 'natuerliche_person',
    applicant_canonical_name: null,
    gutachter_name: null,
  };
}

// ─── Main export ───

/**
 * Extract core identifiers from the first pages of a court file.
 *
 * @param pageTexts - Array of page text strings (index = page number - 1)
 * @param anchorPages - 1-based page numbers to include (typically [1..8])
 * @returns AnchorPacket with all fields, null for anything not found
 */
export async function extractAnchor(
  pageTexts: string[],
  anchorPages: number[],
): Promise<AnchorPacket> {
  // Build page content in "=== SEITE N ===" format
  const pageContent = anchorPages
    .filter((n) => n >= 1 && n <= pageTexts.length)
    .map((n) => `=== SEITE ${n} ===\n${pageTexts[n - 1]}`)
    .join('\n\n');

  let raw: string;
  try {
    const response = await createAnthropicMessage(
      {
        model: config.EXTRACTION_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: pageContent,
          },
        ],
      },
      ANCHOR_SYSTEM_PROMPT,
    );

    const block = response.content[0];
    raw = block.type === 'text' ? block.text : '';
  } catch (err) {
    logger.warn('Anchor-Pass: API-Aufruf fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
      inputPages: anchorPages,
    });
    return emptyAnchorPacket();
  }

  // Parse JSON (with repair for minor syntax issues)
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonrepair(raw));
  } catch (err) {
    logger.warn('Anchor-Pass: JSON-Parse fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
      rawPreview: raw.slice(0, 200),
    });
    return emptyAnchorPacket();
  }

  // Build typed packet, defaulting missing values to null
  const validDebtor_types = ['natuerliche_person', 'juristische_person', 'personengesellschaft'] as const;
  const debtor_type = validDebtor_types.includes(parsed.debtor_type as typeof validDebtor_types[number])
    ? (parsed.debtor_type as AnchorPacket['debtor_type'])
    : 'natuerliche_person';

  const anchor: AnchorPacket = {
    aktenzeichen: typeof parsed.aktenzeichen === 'string' ? parsed.aktenzeichen : null,
    gericht: typeof parsed.gericht === 'string' ? parsed.gericht : null,
    beschlussdatum: typeof parsed.beschlussdatum === 'string' ? parsed.beschlussdatum : null,
    antragsdatum: typeof parsed.antragsdatum === 'string' ? parsed.antragsdatum : null,
    debtor_canonical_name: typeof parsed.debtor_canonical_name === 'string' ? parsed.debtor_canonical_name : null,
    debtor_rechtsform: typeof parsed.debtor_rechtsform === 'string' ? parsed.debtor_rechtsform : null,
    debtor_type,
    applicant_canonical_name: typeof parsed.applicant_canonical_name === 'string' ? parsed.applicant_canonical_name : null,
    gutachter_name: typeof parsed.gutachter_name === 'string' ? parsed.gutachter_name : null,
  };

  // Count non-null fields for telemetry
  const fieldsFound = Object.values(anchor).filter((v) => v !== null).length;

  logger.info('Anchor-Pass abgeschlossen', {
    aktenzeichen: anchor.aktenzeichen,
    debtor_type: anchor.debtor_type,
    fieldsFound,
    inputPages: anchorPages,
  });

  return anchor;
}

// ─── Context formatter ───

/**
 * Format an AnchorPacket as a human-readable context block
 * for inclusion at the top of subsequent extraction prompts.
 *
 * Only non-null fields are included.
 */
export function formatAnchorContext(anchor: AnchorPacket): string {
  const lines: string[] = ['--- AKTENKONTEXT (bereits identifiziert) ---'];

  if (anchor.aktenzeichen !== null) {
    lines.push(`Aktenzeichen: ${anchor.aktenzeichen}`);
  }
  if (anchor.gericht !== null) {
    lines.push(`Gericht: ${anchor.gericht}`);
  }
  if (anchor.beschlussdatum !== null) {
    lines.push(`Beschlussdatum: ${anchor.beschlussdatum}`);
  }
  if (anchor.antragsdatum !== null) {
    lines.push(`Antragsdatum: ${anchor.antragsdatum}`);
  }
  if (anchor.debtor_canonical_name !== null) {
    lines.push(`Schuldner: ${anchor.debtor_canonical_name}`);
  }
  if (anchor.debtor_rechtsform !== null) {
    lines.push(`Rechtsform: ${anchor.debtor_rechtsform}`);
  }
  if (anchor.debtor_type !== null) {
    const typeLabel: Record<AnchorPacket['debtor_type'], string> = {
      natuerliche_person: 'Natürliche Person',
      juristische_person: 'Juristische Person',
      personengesellschaft: 'Personengesellschaft',
    };
    lines.push(`Schuldnertyp: ${typeLabel[anchor.debtor_type]}`);
  }
  if (anchor.applicant_canonical_name !== null) {
    lines.push(`Antragsteller: ${anchor.applicant_canonical_name}`);
  }
  if (anchor.gutachter_name !== null) {
    lines.push(`Gutachter: ${anchor.gutachter_name}`);
  }

  lines.push('---');
  return lines.join('\n');
}
