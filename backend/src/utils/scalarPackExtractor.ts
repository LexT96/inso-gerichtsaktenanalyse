/**
 * Generic scalar field pack extractor engine — Stage 2 of the fieldpack pipeline.
 *
 * Takes a FieldPackDefinition, page texts, routing metadata, and an anchor context,
 * calls the LLM to extract the listed scalar fields, and returns ExtractionCandidate[].
 *
 * Each pack call is self-contained: it builds its own prompt, runs the LLM call,
 * parses the response, and maps entries to candidates with provenance metadata.
 */
import { jsonrepair } from 'jsonrepair';
import { createAnthropicMessage } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import { formatAnchorContext } from './anchorExtractor';
import { buildEnrichedPageBlock } from './ocrEnricher';
import type { OcrResult } from '../services/ocrService';
import type {
  AnchorPacket,
  ExtractionCandidate,
  FieldPackDefinition,
  SegmentSourceType,
} from '../types/extraction';
// ─── System Prompt ───
const PACK_SYSTEM_PROMPT = `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Deine Aufgabe ist es, aus dem vorliegenden Akteninhalt die dir genannten Felder präzise zu extrahieren.
REGELN:
- Extrahiere AUSSCHLIESSLICH die explizit aufgelisteten Felder — keine anderen
- Jeder Wert MUSS direkt aus dem Text stammen — keine Schätzungen, keine Annahmen, keine Berechnungen
- Datumsformat: TT.MM.JJJJ (z.B. 18.12.2025)
- Betragsformat: IMMER als reine Zahl ohne Tausendertrennzeichen (z.B. 100000.00 NICHT 100.000,00)
- NIEMALS Beträge selbst addieren oder berechnen — nur den exakten Wert aus dem Dokument übernehmen
- Felder, die nicht im Dokument gefunden wurden, WEGLASSEN (nicht mit null befüllen)
- Die "quelle" muss die tatsächliche Fundstelle sein: "Seite X, [Beschreibung]" (z.B. "Seite 3, Beschluss vom 18.12.2025")
- Verwende die Seitenzahl aus den "=== SEITE X ===" Markierungen — NICHT aufgedruckte Seitenzahlen
ANTWORTFORMAT:
Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks, keine Erklärungen.
{
  "feldpfad": {"wert": "...", "quelle": "Seite X, ..."},
  "anderes.feld": {"wert": "...", "quelle": "Seite Y, ..."}
}
Beispiel:
{
  "verfahrensdaten.aktenzeichen": {"wert": "35 IN 42/26", "quelle": "Seite 1, Beschluss"},
  "schuldner.name": {"wert": "Müller", "quelle": "Seite 2, Insolvenzantrag"}
}`;
// ─── Page number parser ───
/**
 * Extract a page number from a quelle string like "Seite 5, Beschluss".
 * Returns null if not parseable.
 */
function parsePageFromQuelle(quelle: string): number | null {
  const match = /Seite\s+(\d+)/i.exec(quelle);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return isNaN(n) ? null : n;
}
// ─── Main export ───
/**
 * Execute a field pack: extract all listed fields from the given pages.
 *
 * @param pack         - FieldPackDefinition describing what to extract
 * @param pageTexts    - All page texts (0-indexed: pageTexts[0] = page 1)
 * @param pages        - Which pages to include (1-indexed)
 * @param segmentTypes - Source types for candidate metadata (primary = index 0)
 * @param anchor       - Anchor context to prepend when pack.requiresAnchor = true
 * @param ocrResult    - Optional OCR data for enriched page content
 * @returns Array of ExtractionCandidate, one per successfully extracted field
 */
export async function executeFieldPack(
  pack: FieldPackDefinition,
  pageTexts: string[],
  pages: number[],
  segmentTypes: SegmentSourceType[],
  anchor: AnchorPacket,
  ocrResult?: OcrResult | null,
): Promise<ExtractionCandidate[]> {
  if (pages.length === 0) {
    logger.info(`Pack "${pack.id}" übersprungen — keine Seiten zugewiesen`, {
      packId: pack.id,
    });
    return [];
  }
  // ─── Build page content ───
  const pageContent = ocrResult
    ? buildEnrichedPageBlock(ocrResult, pages, pageTexts)
    : pages
        .filter((n) => n >= 1 && n <= pageTexts.length)
        .map((n) => `=== SEITE ${n} ===\n${pageTexts[n - 1]}`)
        .join('\n\n');
  // ─── Build user prompt ───
  const promptParts: string[] = [];
  if (pack.requiresAnchor) {
    promptParts.push(formatAnchorContext(anchor));
    promptParts.push('');
  }
  promptParts.push(pack.prompt);
  promptParts.push('');
  promptParts.push('Zu extrahierende Felder:');
  for (const field of pack.fields) {
    promptParts.push(`- ${field}`);
  }
  promptParts.push('');
  promptParts.push(pageContent);
  const userPrompt = promptParts.join('\n');
  // ─── Call LLM ───
  let raw: string;
  try {
    const response = await createAnthropicMessage(
      {
        model: config.EXTRACTION_MODEL,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      },
      PACK_SYSTEM_PROMPT,
    );
    const block = response.content[0];
    raw = block.type === 'text' ? block.text : '';
  } catch (err) {
    logger.warn(`Pack "${pack.id}": API-Aufruf fehlgeschlagen`, {
      packId: pack.id,
      error: err instanceof Error ? err.message : String(err),
      inputPages: pages,
    });
    return [];
  }
  // ─── Parse response JSON ───
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonrepair(raw));
  } catch (err) {
    logger.warn(`Pack "${pack.id}": JSON-Parse fehlgeschlagen`, {
      packId: pack.id,
      error: err instanceof Error ? err.message : String(err),
      rawPreview: raw.slice(0, 200),
    });
    return [];
  }
  // ─── Convert to ExtractionCandidate[] ───
  const primarySegmentType: SegmentSourceType = segmentTypes[0] ?? 'sonstiges';
  const candidates: ExtractionCandidate[] = [];
  for (const [fieldPath, entry] of Object.entries(parsed)) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !('wert' in entry) ||
      !('quelle' in entry)
    ) {
      continue;
    }
    const typedEntry = entry as { wert: unknown; quelle: unknown };
    // Skip fields with null/empty values
    if (typedEntry.wert === null || typedEntry.wert === undefined || typedEntry.wert === '') {
      continue;
    }
    const quelle = typeof typedEntry.quelle === 'string' ? typedEntry.quelle : '';
    const page = parsePageFromQuelle(quelle);
    candidates.push({
      fieldPath,
      wert: typedEntry.wert,
      quelle,
      page,
      segmentType: primarySegmentType,
      packId: pack.id,
    });
  }
  // ─── Log result ───
  logger.info(`Pack "${pack.id}" abgeschlossen`, {
    packId: pack.id,
    fieldsExtracted: candidates.length,
    fieldsRequested: pack.fields.length,
    inputPages: pages.length,
  });
  return candidates;
}
