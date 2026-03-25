import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { config } from '../config';
import { extractionResultSchema } from '../utils/validation';
import { logger } from '../utils/logger';
import { parallelLimitSettled } from '../utils/parallel';
import type { DocumentSegment } from '../utils/documentAnalyzer';
import type { ExtractionResult, Standardanschreiben, FehlendInfo } from '../types/extraction';

export const anthropic = new Anthropic({
  apiKey: config.ANTHROPIC_API_KEY,
  ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}),
});

// Max pages per document-aware chunk (soft limit — won't split a document)
const MAX_PAGES_PER_CHUNK = 40;
// Fallback: 30 pages per chunk when no segments available
const FALLBACK_PAGES_PER_CHUNK = 30;
// Concurrency limit for parallel extraction chunks
const EXTRACTION_CONCURRENCY = 3;
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

PFLICHT: Jedes Feld mit ausgefülltem "wert" MUSS eine "quelle" haben. Ohne Quelle ist die Extraktion unbrauchbar. Die quelle MUSS die exakte Fundstelle angeben: die Seite, auf der du den Wert im vorliegenden Akteninhalt gefunden hast. Format: "Seite X, [Dokument/Abschnitt]". Beispiele: "Seite 1, Beschluss vom 18.12.2025", "Seite 3, Insolvenzantrag der HEK", "Seite 7, Mitteilung des Gerichtsvollziehers". Regel: wert nicht leer → quelle nicht leer.
WICHTIG: Die quelle muss die tatsächliche Fundstelle sein — die Seite, auf der du den Wert im vorliegenden Dokument gefunden hast. Bei textbasiertem Akteninhalt mit "=== SEITE X ===": genau diese X verwenden. Bei PDF: die Seitenzahl der Seite, auf der der Wert erscheint. Keine generischen oder geschätzten Quellen (z.B. nicht "Seite 1, Insolvenzantrag" für Werte, die auf einer anderen Seite stehen).
Datumsformat: TT.MM.JJJJ (z.B. 18.12.2025). Beträge: deutsche Schreibweise mit Komma (1.234,56) oder Zahl.

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks). WICHTIG: In allen String-Werten Anführungszeichen mit \\ escapen, keine Zeilenumbrüche innerhalb von Strings. Bei Zahlen: Nur 0 setzen, wenn der Wert tatsächlich 0 in der Akte steht — sonst null und quelle leer lassen. Verwende folgende Struktur:

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
  "zusammenfassung": [{"wert": "Kernpunkt der Zusammenfassung", "quelle": "Seite X, Abschnitt"}],
  "risiken_hinweise": [{"wert": "Risiko oder Hinweis", "quelle": "Seite X, Abschnitt"}]
}

Die 10 Standardanschreiben-Typen (je ein Dokument) sind:
1. Bankenauskunft
2. Bausparkassen-Anfrage
3. Steuerberater-Kontakt
4. Strafakte-Akteneinsicht
5. KFZ-Halteranfrage Zulassungsstelle
6. Gewerbeauskunft
7. Finanzamt-Anfrage
8. KFZ-Halteranfrage KBA
9. Versicherungsanfrage
10. Gerichtsvollzieher-Anfrage

Für jeden Typ bestimme ob: "bereit" (alle Daten da, sofort generierbar), "fehlt" (Daten unvollständig), oder "entfaellt" (Anfrage nicht nötig/bereits erledigt).
WICHTIG: "bereit" NUR wenn fehlende_daten LEER ist. Bei "bereit" darf fehlende_daten keine Einträge haben.
"entfaellt" wenn: (a) bereits vom Gericht erledigt, ODER (b) der Sachverhalt nicht vorliegt (z.B. keine Fahrzeuge → KFZ-Anfragen entfallen; keine Versicherungen bekannt → Versicherungsanfrage kann trotzdem bereit sein mit generischem Empfänger).
"fehlt" wenn konkrete Daten fehlen, um den Brief zu versenden (z.B. Name der Krankenkasse, Name des Gerichtsvollziehers).
WICHTIG für empfaenger: Wenn eine konkrete Institution/Person aus der Akte bekannt ist, trage diese ein. Wenn nicht, verwende den generischen Empfänger des Typs.
Bei "fehlt" liste die fehlenden Datenfelder in fehlende_daten auf.
Bei "entfaellt" begründe warum (z.B. "Bereits vom Gericht angefragt" oder "Kein Grundvermögen vorhanden").

WICHTIG — "nicht bekannt" betrifft NUR das jeweilige Feld:
- Wenn das Dokument eine Information als unbekannt beschreibt ("ist mir nicht bekannt", "konnte nicht ermittelt werden"), setze NUR DIESES EINE FELD auf null. Alle anderen Felder im selben Abschnitt werden normal extrahiert.

Wenn eine DOKUMENTSTRUKTUR mitgegeben wird, nutze sie NUR um zu verstehen welcher Dokumentteil was enthält. Die SEITENZAHLEN in der quelle müssen von der EXAKTEN Seite kommen, auf der du den Wert im Akteninhalt findest — NICHT aus der Dokumentstruktur-Übersicht.

Extrahiere ALLE verfügbaren Daten. Bei fehlenden Informationen setze null/leere Strings und fülle fehlende_informationen mit konkreten Hinweisen, wie die Information ermittelt werden kann.
Für betroffene_arbeitnehmer: Bei Arbeitnehmerangaben Objekte mit anzahl, typ, quelle (z.B. {"anzahl":44,"typ":"Arbeitnehmer insgesamt","quelle":"Seite 7, Angaben zu Arbeitnehmerverhältnissen"}). Sonst [].
Für befugnisse: Extrahiere die konkreten Befugnisse aus dem Beschluss als Textstrings (z.B. ["Sicherungsmaßnahmen gem. § 21 InsO", "Einholung von Auskünften"]). Keine leeren Strings. Wenn keine Befugnisse im Dokument stehen, leere Liste [].

WICHTIG — Boolean-Felder (grundbesitz_vorhanden, betriebsstaette_bekannt, masse_deckend, vermoegensauskunft_abgegeben, haftbefehle, schuldnerverzeichnis_eintrag, vermoegensverzeichnis_eintrag):
- "ja" / bestätigt / vorhanden → true
- "nein" / "kein" / "keine" / "nicht vorhanden" / "hier ist kein..." / "Keine Daten gefunden" → false (NICHT null!)
- null NUR wenn die Information weder bestätigt noch verneint wird, d.h. die Ermittlung gar nicht stattgefunden hat oder das Ergebnis völlig unbekannt ist
- Beispiel: Grundbuchamt antwortet "hier ist kein Grundbesitz ersichtlich" → grundbesitz_vorhanden: false (NICHT null)
- Beispiel: Kein Grundbuchschreiben in der Akte → grundbesitz_vorhanden: null

ERINNERUNG: Jeder nicht-leere wert braucht eine quelle (Seite X, ...). Keine Ausnahme.

WICHTIG für fehlende_informationen: Jeder Eintrag MUSS ein Objekt mit allen drei Feldern sein. Das Feld "information" darf NIEMALS leer sein — trage dort stets eine kurze, prägnante Bezeichnung der fehlenden Information ein (z.B. "Beschlussdatum des Insolvenzgerichts", "Konkrete Bankverbindungen"). Keine Platzhalter wie {"information":"","grund":"..."} ausgeben. Wenn nichts fehlt, leere Liste []. Maximal 15 Einträge — nur die wichtigsten fehlenden Informationen, keine Wiederholungen.`;

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

const MAX_RETRIES = 3;

export async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        const delay = RATE_LIMIT_RETRY_DELAY_MS * (attempt + 1);
        logger.warn(`Rate-Limit (Versuch ${attempt + 1}/${MAX_RETRIES}). Warte ${delay / 1000}s…`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error('callWithRetry: max retries exhausted');
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
    const winningStatus = newPrio >= existPrio ? letter.status : existing.status;
    // "bereit" und "entfaellt" schließen fehlende_daten aus — nur bei "fehlt" kombinieren
    const fehlendeDaten =
      winningStatus === 'fehlt'
        ? [...new Set([...(existing.fehlende_daten || []), ...(letter.fehlende_daten || [])])]
        : [];
    const merged: Standardanschreiben = {
      typ: letter.typ,
      empfaenger: existing.empfaenger || letter.empfaenger,
      status: winningStatus,
      begruendung: (newPrio >= existPrio ? letter.begruendung : existing.begruendung) || existing.begruendung || letter.begruendung,
      fehlende_daten: fehlendeDaten,
    };
    byTyp.set(letter.typ, merged);
  }
  return Array.from(byTyp.values());
}

function mergeFehlendeInformationen(a: FehlendInfo[], b: FehlendInfo[]): FehlendInfo[] {
  const combined = [...a, ...b].filter(
    (item) => item && typeof item.information === 'string' && item.information.trim() !== ''
  );
  const byKey = new Map<string, FehlendInfo>();
  for (const item of combined) {
    const key = item.information.trim().toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      information: item.information,
      grund: item.grund || existing.grund,
      ermittlung_ueber: item.ermittlung_ueber || existing.ermittlung_ueber,
    });
  }
  return Array.from(byKey.values());
}

function mergeField(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Standardanschreiben: merge by Typ with status priority
    const firstItem = a[0] ?? b[0];
    if (firstItem && typeof firstItem === 'object' && 'typ' in (firstItem as object)) {
      return mergeStandardanschreiben(a as Standardanschreiben[], b as Standardanschreiben[]);
    }
    // Fehlende Informationen: merge by information, filter empty placeholders
    if (firstItem && typeof firstItem === 'object' && 'information' in (firstItem as object)) {
      return mergeFehlendeInformationen(a as FehlendInfo[], b as FehlendInfo[]);
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
    // {wert, quelle} field: take best value (prefer non-empty quelle when both have wert)
    if ('wert' in aObj) {
      const aW = aObj['wert'];
      const bW = (bObj as Record<string, unknown>)['wert'];
      const aEmpty = aW === null || aW === undefined || aW === '';
      const bEmpty = bW === null || bW === undefined || bW === '';
      if (aEmpty) return b;
      if (bEmpty) return a;
      const aQ = String((aObj as Record<string, unknown>).quelle ?? '').trim();
      const bQ = String((bObj as Record<string, unknown>).quelle ?? '').trim();
      return bQ && !aQ ? b : a;
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
  if (results.length === 0) {
    return extractionResultSchema.parse({}) as unknown as ExtractionResult;
  }
  return results.reduce((merged, current) =>
    mergeField(merged, current) as ExtractionResult
  );
}

// ─── JSON extraction from Claude response ───

export function extractJsonFromText(text: string): string {
  // 1. Extract from ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  // 2. Fallback: strip ``` markers and trim
  const stripped = text.replace(/```json|```/g, '').trim();
  if (stripped) return stripped;
  // 3. Last resort: find outermost JSON structure (object or array)
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const start = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace) ? firstBracket : firstBrace;
  const end = lastBracket >= 0 && (lastBrace < 0 || lastBracket > lastBrace) ? lastBracket : lastBrace;
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
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

  // safeParse failed but the preprocess schema should handle anything.
  // Last resort: return the parsed data directly — better partial data than empty.
  logger.warn('Schema-Validierung fehlgeschlagen, verwende geparste Rohdaten');
  return (parsed ?? {}) as ExtractionResult;
}

// ─── Document-Aware Chunking ───

interface DocumentChunk {
  /** Segments included in this chunk */
  segments: DocumentSegment[];
  /** All page numbers in this chunk (sorted) */
  pages: number[];
  /** Human-readable label of document types in this chunk */
  documentContext: string;
}

/**
 * Group document segments into chunks that keep documents together.
 *
 * Algorithm:
 * - Add segments to current chunk until page limit is exceeded
 * - Never split a single document across chunks
 * - If a single document exceeds the limit, it gets its own chunk
 */
export function buildDocumentAwareChunks(
  segments: DocumentSegment[],
  maxPagesPerChunk: number = MAX_PAGES_PER_CHUNK
): DocumentChunk[] {
  if (segments.length === 0) return [];

  const chunks: DocumentChunk[] = [];
  let currentSegments: DocumentSegment[] = [];
  let currentPages: number[] = [];

  for (const segment of segments) {
    // If adding this segment would exceed the limit and we already have content, start a new chunk
    if (currentPages.length + segment.pages.length > maxPagesPerChunk && currentPages.length > 0) {
      chunks.push(buildChunk(currentSegments));
      currentSegments = [];
      currentPages = [];
    }

    currentSegments.push(segment);
    currentPages.push(...segment.pages);
  }

  // Don't forget the last chunk
  if (currentSegments.length > 0) {
    chunks.push(buildChunk(currentSegments));
  }

  return chunks;
}

function buildChunk(segments: DocumentSegment[]): DocumentChunk {
  const allPages = segments.flatMap(s => s.pages).sort((a, b) => a - b);
  // Deduplicate pages (segments might overlap)
  const uniquePages = [...new Set(allPages)].sort((a, b) => a - b);

  const docLabels = segments
    .filter(s => s.type !== 'Sonstige Dokumente')
    .map(s => {
      const pageRange = s.pages.length === 1
        ? `Seite ${s.pages[0]}`
        : `Seiten ${s.pages[0]}-${s.pages[s.pages.length - 1]}`;
      return `${s.type} (${pageRange})`;
    });

  return {
    segments,
    pages: uniquePages,
    documentContext: docLabels.length > 0 ? docLabels.join(', ') : '',
  };
}

// ─── Claude API call ───

async function callClaudeText(content: string): Promise<ExtractionResult> {
  const response = await anthropic.messages.create({
    model: config.EXTRACTION_MODEL,
    max_tokens: 16_000,
    messages: [{ role: 'user' as const, content }],
  }) as Anthropic.Message;

  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c: Anthropic.TextBlock) => c.text)
    .join('');

  return parseAndValidateResponse(text);
}

// ─── Public API ───

export async function extractFromPdfBuffer(pdfBuffer: Buffer, documentMap?: string): Promise<ExtractionResult> {
  const base64 = pdfBuffer.toString('base64');
  logger.info('Starte Claude API-Aufruf mit PDF-Dokument');

  const promptText = documentMap
    ? `${EXTRACTION_PROMPT}\n\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---`
    : EXTRACTION_PROMPT;

  const response = await callWithRetry(() => anthropic.messages.create({
    model: config.EXTRACTION_MODEL,
    max_tokens: 16_000,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
        { type: 'text' as const, text: promptText },
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
 * Extracts using document-aware chunks that keep related pages together.
 * Runs chunks in parallel for speed while preserving document coherence.
 *
 * Falls back to simple page-based chunking when no segments are available.
 */
export async function extractFromPageTexts(
  pageTexts: string[],
  documentMap?: string,
  segments?: DocumentSegment[]
): Promise<ExtractionResult> {
  const totalPages = pageTexts.length;

  // If we have segments, use document-aware chunking; otherwise fallback to fixed-size
  const chunks = segments && segments.length > 0
    ? buildDocumentAwareChunks(segments)
    : buildFallbackChunks(totalPages);

  logger.info('Extraktion Chunking', {
    totalPages,
    chunks: chunks.length,
    documentAware: !!(segments && segments.length > 0),
    pagesPerChunk: chunks.map(c => c.pages.length),
  });

  const mapBlock = documentMap
    ? `\n\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
    : '';

  // Build extraction tasks — all use the full prompt + document map
  const tasks = chunks.map((chunk, i) => () => {
    const chunkText = chunk.pages
      .map(p => `=== SEITE ${p} ===\n${pageTexts[p - 1]}`)
      .join('\n\n');

    const docContext = chunk.documentContext
      ? `\nDiese Seiten enthalten: ${chunk.documentContext}\n`
      : '';

    const pageRange = chunk.pages.length === 1
      ? `Seite ${chunk.pages[0]}`
      : `Seiten ${chunk.pages[0]}–${chunk.pages[chunk.pages.length - 1]}`;

    const content = `${EXTRACTION_PROMPT}${mapBlock}${docContext}\n--- AKTENINHALT (${pageRange} von ${totalPages}) ---\n\n${chunkText}`;

    logger.info(`Chunk ${i + 1}/${chunks.length} gestartet (${pageRange}, ${chunk.pages.length} Seiten)`);

    return callWithRetry(() => callClaudeText(content));
  });

  // Run chunks in parallel with concurrency limit
  const { results, errors } = await parallelLimitSettled(tasks, EXTRACTION_CONCURRENCY);

  // Log errors but continue with successful results
  const successfulResults: ExtractionResult[] = [];
  for (let i = 0; i < results.length; i++) {
    if (errors[i]) {
      logger.warn(`Chunk ${i + 1}/${chunks.length} fehlgeschlagen`, {
        error: errors[i]!.message,
        pages: chunks[i].pages.length,
      });
    } else if (results[i]) {
      successfulResults.push(results[i]!);
    }
  }

  if (successfulResults.length === 0) {
    throw new Error('Alle Extraktions-Chunks sind fehlgeschlagen');
  }

  if (errors.some(e => e !== undefined)) {
    logger.warn('Teilweise Extraktion', {
      successful: successfulResults.length,
      failed: errors.filter(e => e !== undefined).length,
    });
  }

  return mergeExtractionResults(successfulResults);
}

/**
 * Fallback chunking when no document segments are available.
 * Splits pages into fixed-size chunks (same as the old approach).
 */
function buildFallbackChunks(totalPages: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (let i = 0; i < totalPages; i += FALLBACK_PAGES_PER_CHUNK) {
    const pages: number[] = [];
    for (let p = i + 1; p <= Math.min(i + FALLBACK_PAGES_PER_CHUNK, totalPages); p++) {
      pages.push(p);
    }
    chunks.push({ segments: [], pages, documentContext: '' });
  }
  return chunks;
}

/**
 * Fallback: single-string text extraction (used when per-page extraction fails).
 */
export async function extractFromText(pdfText: string): Promise<ExtractionResult> {
  logger.info('Text-Fallback (Volltext)', { chars: pdfText.length });
  const content = `${EXTRACTION_PROMPT}\n\n--- AKTENINHALT ---\n\n${pdfText}`;
  return callWithRetry(() => callClaudeText(content));
}
