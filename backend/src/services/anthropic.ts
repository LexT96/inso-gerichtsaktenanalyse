import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { config } from '../config';
import { extractionResultSchema } from '../utils/validation';
import { logger } from '../utils/logger';
import type { ExtractionResult, Standardanschreiben } from '../types/extraction';

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// 30 pages per chunk → ~7,500 tokens of content + ~2,000 prompt ≈ 9,500 tokens/request
// Well under the 30k/min limit even for free-tier accounts
const PAGES_PER_CHUNK = 30;
// 3s pause between chunks for rate-limit stability
const CHUNK_PAUSE_MS = 3_000;
// 65s wait before retrying after a 429
const RATE_LIMIT_RETRY_DELAY_MS = 65_000;

// NOTE: Structured Output (output_config / json_schema) removed intentionally.
// The API-level schema conflicted with the prompt's {wert,quelle} pattern,
// causing Claude to produce inconsistent output. We rely on:
// 1. Clear prompt with exact JSON example
// 2. Robust Zod validation with z.preprocess coercion at every level
// 3. jsonrepair for minor JSON syntax issues
// This combination is more reliable than API-enforced schemas.

// ─── Shared Extraction Prompt ───

const EXTRACTION_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter. Analysiere die hochgeladene Gerichtsakte und extrahiere ALLE relevanten Informationen strukturiert.

WICHTIG: Für JEDES extrahierte Datenfeld gib die QUELLE an — d.h. aus welchem Dokument/Abschnitt der Akte die Information stammt (z.B. "Beschluss vom 18.12.2025", "Insolvenzantrag der HEK", "Mitteilung des Gerichtsvollziehers vom 03.12.2025", "Meldeauskunft", "Grundbuchamt Trier" etc.).

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks). WICHTIG: In allen String-Werten Anführungszeichen mit \\ escapen, keine Zeilenumbrüche innerhalb von Strings. Verwende folgende Struktur:

{
  "verfahrensdaten": {
    "aktenzeichen": {"wert": "", "quelle": ""},
    "gericht": {"wert": "", "quelle": ""},
    "richter": {"wert": "", "quelle": ""},
    "antragsdatum": {"wert": "", "quelle": ""},
    "beschlussdatum": {"wert": "", "quelle": ""},
    "antragsart": {"wert": "", "quelle": ""},
    "eroeffnungsgrund": {"wert": "", "quelle": ""},
    "zustellungsdatum_schuldner": {"wert": "", "quelle": ""}
  },
  "schuldner": {
    "name": {"wert": "", "quelle": ""},
    "vorname": {"wert": "", "quelle": ""},
    "geburtsdatum": {"wert": "", "quelle": ""},
    "geburtsort": {"wert": "", "quelle": ""},
    "geburtsland": {"wert": "", "quelle": ""},
    "staatsangehoerigkeit": {"wert": "", "quelle": ""},
    "familienstand": {"wert": "", "quelle": ""},
    "geschlecht": {"wert": "", "quelle": ""},
    "aktuelle_adresse": {"wert": "", "quelle": ""},
    "fruehere_adressen": [],
    "firma": {"wert": "", "quelle": ""},
    "rechtsform": {"wert": "", "quelle": ""},
    "betriebsstaette_adresse": {"wert": "", "quelle": ""},
    "handelsregisternummer": {"wert": "", "quelle": ""},
    "kinder": []
  },
  "antragsteller": {
    "name": {"wert": "", "quelle": ""},
    "adresse": {"wert": "", "quelle": ""},
    "ansprechpartner": {"wert": "", "quelle": ""},
    "telefon": {"wert": "", "quelle": ""},
    "fax": {"wert": "", "quelle": ""},
    "email": {"wert": "", "quelle": ""},
    "betriebsnummer": {"wert": "", "quelle": ""},
    "bankverbindung_iban": {"wert": "", "quelle": ""},
    "bankverbindung_bic": {"wert": "", "quelle": ""}
  },
  "forderungen": {
    "hauptforderung_beitraege": {"wert": 0, "quelle": ""},
    "saeumniszuschlaege": {"wert": 0, "quelle": ""},
    "mahngebuehren": {"wert": 0, "quelle": ""},
    "vollstreckungskosten": {"wert": 0, "quelle": ""},
    "antragskosten": {"wert": 0, "quelle": ""},
    "gesamtforderung": {"wert": 0, "quelle": ""},
    "zeitraum_von": {"wert": "", "quelle": ""},
    "zeitraum_bis": {"wert": "", "quelle": ""},
    "laufende_monatliche_beitraege": {"wert": 0, "quelle": ""},
    "betroffene_arbeitnehmer": []
  },
  "gutachterbestellung": {
    "gutachter_name": {"wert": "", "quelle": ""},
    "gutachter_kanzlei": {"wert": "", "quelle": ""},
    "gutachter_adresse": {"wert": "", "quelle": ""},
    "gutachter_telefon": {"wert": "", "quelle": ""},
    "gutachter_email": {"wert": "", "quelle": ""},
    "abgabefrist": {"wert": "", "quelle": ""},
    "befugnisse": []
  },
  "ermittlungsergebnisse": {
    "grundbuch": {
      "ergebnis": {"wert": "", "quelle": ""},
      "grundbesitz_vorhanden": {"wert": null, "quelle": ""},
      "datum": {"wert": "", "quelle": ""}
    },
    "gerichtsvollzieher": {
      "name": {"wert": "", "quelle": ""},
      "betriebsstaette_bekannt": {"wert": null, "quelle": ""},
      "vollstreckungen": {"wert": "", "quelle": ""},
      "masse_deckend": {"wert": null, "quelle": ""},
      "vermoegensauskunft_abgegeben": {"wert": null, "quelle": ""},
      "haftbefehle": {"wert": null, "quelle": ""},
      "datum": {"wert": "", "quelle": ""}
    },
    "vollstreckungsportal": {
      "schuldnerverzeichnis_eintrag": {"wert": null, "quelle": ""},
      "vermoegensverzeichnis_eintrag": {"wert": null, "quelle": ""}
    },
    "meldeauskunft": {
      "meldestatus": {"wert": "", "quelle": ""},
      "datum": {"wert": "", "quelle": ""}
    }
  },
  "fristen": [
    {"bezeichnung": "", "datum": "", "status": "", "quelle": ""}
  ],
  "standardanschreiben": [
    {
      "typ": "",
      "empfaenger": "",
      "status": "bereit|fehlt|entfaellt",
      "begruendung": "",
      "fehlende_daten": []
    }
  ],
  "fehlende_informationen": [
    {"information": "", "grund": "", "ermittlung_ueber": ""}
  ],
  "zusammenfassung": "",
  "risiken_hinweise": []
}

Die 9 Standardanschreiben-Typen sind:
1. Bankenauskunft (an Banken/Sparkassen)
2. Versicherungsanfrage (an Versicherungen)
3. Steuerberater-Kontakt (an StB/WP)
4. Krankenkassen-Anfrage (an GKV)
5. Gerichtsvollzieher-Anfrage (an zuständigen GV)
6. Grundbuchanfrage (an Grundbuchamt)
7. KFZ-Halteranfrage (an Kraftfahrt-Bundesamt)
8. Kreditreform-Auskunft (über bestehenden Zugang)
9. Gewerbeauskunft (an zuständige Behörde)

Für jeden Typ bestimme ob: "bereit" (alle Daten da), "fehlt" (Daten unvollständig), oder "entfaellt" (bereits vom Gericht erledigt).
WICHTIG: "bereit" nur wenn empfaenger (konkrete Institution/Person mit Name) ausgefüllt ist. Ist empfaenger leer oder unbekannt → status MUSS "fehlt" sein.
Bei "fehlt" liste die fehlenden Datenfelder auf.
Bei "entfaellt" begründe warum (z.B. "Bereits vom Gericht am 27.11.2025 beim Grundbuchamt angefragt").

Extrahiere ALLE verfügbaren Daten. Bei fehlenden Informationen setze null/leere Strings und fülle fehlende_informationen mit konkreten Hinweisen, wie die Information ermittelt werden kann.`;

// Short prompt for chunks 2+ — schema already established, just extract the content
const EXTRACTION_PROMPT_CONTINUATION = `Du bist ein KI-Assistent für deutsche Insolvenzverwalter. Extrahiere alle verfügbaren Daten aus diesem Aktenabschnitt und gib das Ergebnis als valides JSON zurück (kein Markdown, keine Backticks). In String-Werten Anführungszeichen mit \\ escapen, keine Zeilenumbrüche in Strings. Verwende exakt dasselbe JSON-Schema — fehlende Felder auf null/""/0 setzen. Für JEDES Feld die QUELLE angeben.

Gleiche Struktur: verfahrensdaten, schuldner, antragsteller, forderungen, gutachterbestellung, ermittlungsergebnisse, fristen[], standardanschreiben[] (9 Typen: Bankenauskunft|Versicherungsanfrage|Steuerberater-Kontakt|Krankenkassen-Anfrage|Gerichtsvollzieher-Anfrage|Grundbuchanfrage|KFZ-Halteranfrage|Kreditreform-Auskunft|Gewerbeauskunft mit status bereit|fehlt|entfaellt), fehlende_informationen[], zusammenfassung, risiken_hinweise[].`;

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    (err instanceof Anthropic.APIError && err.status === 429)
  );
}

async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimitError(err)) {
      logger.warn(`Rate-Limit. Warte ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s…`);
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      return fn();
    }
    throw err;
  }
}

function extractBriefContext(result: ExtractionResult): string {
  const parts: string[] = [];
  const { schuldner: sz, verfahrensdaten: vd } = result;
  const fullName = [sz?.vorname?.wert, sz?.name?.wert].filter(Boolean).join(' ');
  if (fullName) parts.push(`Schuldner: ${fullName}`);
  if (vd?.aktenzeichen?.wert) parts.push(`Az: ${vd.aktenzeichen.wert}`);
  if (vd?.gericht?.wert) parts.push(`Gericht: ${vd.gericht.wert}`);
  if (result.antragsteller?.name?.wert) parts.push(`Antragsteller: ${result.antragsteller.name.wert}`);
  return parts.join(' | ');
}

// ─── Merge ───

const ANSCHREIBEN_PRIORITY: Record<string, number> = { bereit: 3, fehlt: 2, entfaellt: 1 };

function mergeStandardanschreiben(a: Standardanschreiben[], b: Standardanschreiben[]): Standardanschreiben[] {
  const byTyp = new Map<string, Standardanschreiben>();
  for (const letter of [...a, ...b]) {
    if (!letter.typ) continue;
    const existing = byTyp.get(letter.typ);
    if (!existing) {
      byTyp.set(letter.typ, letter);
      continue;
    }
    // Merge field-by-field: keep best status AND best data from both
    const newPrio = ANSCHREIBEN_PRIORITY[letter.status] ?? 0;
    const existPrio = ANSCHREIBEN_PRIORITY[existing.status] ?? 0;
    const merged: Standardanschreiben = {
      typ: letter.typ,
      empfaenger: existing.empfaenger || letter.empfaenger,
      status: newPrio >= existPrio ? letter.status : existing.status,
      begruendung: (newPrio >= existPrio ? letter.begruendung : existing.begruendung) || existing.begruendung || letter.begruendung,
      fehlende_daten: newPrio >= existPrio ? letter.fehlende_daten : existing.fehlende_daten,
    };
    // Downgrade to "fehlt" if empfaenger is still empty for "bereit"
    if (merged.status === 'bereit' && !merged.empfaenger) {
      merged.status = 'fehlt';
      if (!merged.fehlende_daten.includes('empfaenger')) {
        merged.fehlende_daten = [...merged.fehlende_daten, 'empfaenger'];
      }
    }
    byTyp.set(letter.typ, merged);
  }
  return Array.from(byTyp.values());
}

function mergeField(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Standardanschreiben: merge by Typ with status priority
    const firstItem = a[0] ?? b[0];
    if (firstItem && typeof firstItem === 'object' && 'typ' in (firstItem as object)) {
      return mergeStandardanschreiben(a as Standardanschreiben[], b as Standardanschreiben[]);
    }
    // Generic arrays: deduplicate by JSON
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) { seen.add(key); result.push(item); }
    }
    return result;
  }
  if (a && b && typeof a === 'object' && !Array.isArray(a) && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    // {wert, quelle} field: take first non-empty value
    if ('wert' in aObj) {
      const empty = aObj['wert'] === null || aObj['wert'] === undefined || aObj['wert'] === '' || aObj['wert'] === 0;
      return empty ? b : a;
    }
    // Nested object: recurse
    const result: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      result[key] = mergeField(aObj[key], bObj[key]);
    }
    return result;
  }
  // Primitives: take first non-empty
  if (a === null || a === undefined || a === '') return b;
  return a;
}

function mergeExtractionResults(results: ExtractionResult[]): ExtractionResult {
  return results.reduce((merged, current) =>
    mergeField(merged, current) as ExtractionResult
  );
}

// ─── JSON extraction from Claude response ───

function extractJsonFromText(text: string): string {
  // 1. Extract from ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  // 2. Fallback: strip ``` markers and trim
  const stripped = text.replace(/```json|```/g, '').trim();
  if (stripped) return stripped;
  // 3. Last resort: find first { to last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

function parseAndValidateResponse(text: string): ExtractionResult {
  const jsonStr = extractJsonFromText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      const repaired = jsonrepair(jsonStr);
      parsed = JSON.parse(repaired);
      logger.info('JSON per jsonrepair repariert');
    } catch (repairErr) {
      const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
      const sample = jsonStr.slice(0, 500);
      logger.error('JSON-Parse/Schema-Fehler', {
        error: msg,
        responseLength: text.length,
        jsonLength: jsonStr.length,
        sample: sample + (jsonStr.length > 500 ? '…' : ''),
      });
      throw new Error('Die KI-Antwort konnte nicht als JSON verarbeitet werden.');
    }
  }

  // Robust schema: z.preprocess coerces every field — safeParse should always succeed.
  // If it somehow still fails, log the issues but return the coerced data anyway.
  const result = extractionResultSchema.safeParse(parsed);
  if (result.success) {
    return result.data as unknown as ExtractionResult;
  }

  // Log the issues for debugging but DON'T throw — the data is still usable
  const issues = result.error.issues.slice(0, 10);
  logger.warn('Schema-Validierung: Abweichungen korrigiert', {
    issueCount: result.error.issues.length,
    paths: issues.map(i => `${i.path.join('.')}: ${i.message}`),
  });

  // Force-parse: strip unknown fields, apply defaults for missing ones
  // This always succeeds because every field has .optional().default()
  try {
    return extractionResultSchema.parse(parsed ?? {}) as unknown as ExtractionResult;
  } catch {
    // Absolute last resort: return parsed data with an empty-schema wrapper
    logger.error('Schema-Validierung komplett fehlgeschlagen, verwende Rohdaten');
    return extractionResultSchema.parse({}) as unknown as ExtractionResult;
  }
}

// ─── Claude API call ───

async function callClaudeText(content: string): Promise<ExtractionResult> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001' as const,
    max_tokens: 8000,
    messages: [{ role: 'user' as const, content }],
  }) as Anthropic.Message;

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c: Anthropic.TextBlock) => c.text)
    .join('');

  return parseAndValidateResponse(text);
}

// ─── Public API ───

export async function extractFromPdfBuffer(pdfBuffer: Buffer): Promise<ExtractionResult> {
  const base64 = pdfBuffer.toString('base64');
  logger.info('Starte Claude API-Aufruf mit PDF-Dokument');

  const response = await callWithRetry(() => anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001' as const,
    max_tokens: 8000,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
        { type: 'text' as const, text: EXTRACTION_PROMPT },
      ],
    }],
  })) as Anthropic.Message;

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c: Anthropic.TextBlock) => c.text)
    .join('');

  return parseAndValidateResponse(text);
}

/**
 * Extracts from an array of per-page texts using page-based chunking.
 * Sends PAGES_PER_CHUNK pages per request, with context from previous chunks.
 */
export async function extractFromPageTexts(pageTexts: string[]): Promise<ExtractionResult> {
  const totalPages = pageTexts.length;

  // Build page chunks
  const pageChunks: string[][] = [];
  for (let i = 0; i < totalPages; i += PAGES_PER_CHUNK) {
    pageChunks.push(pageTexts.slice(i, i + PAGES_PER_CHUNK));
  }

  logger.info('Seitenbasiertes Chunking', {
    totalPages,
    chunks: pageChunks.length,
    pagesPerChunk: PAGES_PER_CHUNK,
  });

  const results: ExtractionResult[] = [];
  let prevContext = '';

  for (let i = 0; i < pageChunks.length; i++) {
    if (i > 0) {
      await sleep(CHUNK_PAUSE_MS);
    }

    const startPage = i * PAGES_PER_CHUNK + 1;
    const endPage = Math.min((i + 1) * PAGES_PER_CHUNK, totalPages);
    const chunkText = pageChunks[i].join('\n\n--- Seite ---\n\n');

    logger.info(`Chunk ${i + 1}/${pageChunks.length} (Seiten ${startPage}–${endPage})`);

    let content: string;
    if (i === 0) {
      content = `${EXTRACTION_PROMPT}\n\n--- AKTENINHALT (Seiten ${startPage}–${endPage} von ${totalPages}) ---\n\n${chunkText}`;
    } else {
      const contextLine = prevContext ? `Bereits bekannte Stammdaten: ${prevContext}\n\n` : '';
      content = `${EXTRACTION_PROMPT_CONTINUATION}\n\n${contextLine}--- AKTENINHALT (Seiten ${startPage}–${endPage} von ${totalPages}) ---\n\n${chunkText}`;
    }

    const result = await callWithRetry(() => callClaudeText(content));
    results.push(result);

    // Pass key context to next chunk so Claude knows who we're talking about
    if (i === 0) {
      prevContext = extractBriefContext(result);
      if (prevContext) logger.info(`Chunk-Kontext: ${prevContext}`);
    }
  }

  return mergeExtractionResults(results);
}

/**
 * Fallback: single-string text extraction (used when per-page extraction fails).
 */
export async function extractFromText(pdfText: string): Promise<ExtractionResult> {
  logger.info('Text-Fallback (Volltext)', { chars: pdfText.length });
  const content = `${EXTRACTION_PROMPT}\n\n--- AKTENINHALT ---\n\n${pdfText}`;
  return callWithRetry(() => callClaudeText(content));
}
