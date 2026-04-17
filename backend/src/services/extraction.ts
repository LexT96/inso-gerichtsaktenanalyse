import path from 'path';
import { extractComprehensive, extractFromPageTexts, callWithRetry, extractJsonFromText, createAnthropicMessage, EXTRACTION_PROMPT } from './anthropic';
import { extractWithOpenAI } from './openaiExtractor';
import { detectProvider, supportsNativePdf, isRateLimited, logProviderConfig } from './extractionProvider';
import { computeExtractionStats } from '../utils/computeStats';
import { config } from '../config';
import { extractTextPerPage, removeWatermarksFromTexts } from './pdfProcessor';
import { isScannedPdf, isOcrConfigured, ocrPdf, type OcrResult } from './ocrService';
import { registerExtraction } from './rateLimiter';
import { getDb } from '../db/database';
import { writeResultJson } from '../db/resultJson';
import { logger } from '../utils/logger';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { analyzeDocumentStructure, classifySegmentsForExtraction, routeSegmentsToFieldPacks } from '../utils/documentAnalyzer';
import type { DocumentAnalysis, DocumentSegment } from '../utils/documentAnalyzer';
import { extractAnchor } from '../utils/anchorExtractor';
import { executeFieldPack } from '../utils/scalarPackExtractor';
import { ANCHOR_PACK, getPacksForDebtorType } from '../utils/fieldPacks';
import { buildResultFromCandidates } from '../utils/extractionReducer';
import type { ExtractionCandidate, AnchorPacket } from '../types/extraction';
import { extractForderungen } from '../utils/forderungenExtractor';
import { semanticVerify } from '../utils/semanticVerifier';
import { extractAktiva } from '../utils/aktivaExtractor';
import { analyzeAnfechtung } from '../utils/anfechtungsAnalyzer';
import { enrichmentReview } from '../utils/enrichmentReview';
import { PDFDocument } from 'pdf-lib';
import type { ExtractionResult } from '../types/extraction';

const isRateLimitedProvider = (): boolean => isRateLimited(detectProvider());

// PDFs above this threshold use the field pack pipeline (smaller API calls, rate-limit safe).
// Below: monolithic extractComprehensive() for best quality.
//
// As of 2026-04-16: Langdock increased per-model TPM to 200K.
// 87-page PDF (150K+ tokens) completes successfully via monolithic pipeline.
// Field packs only needed as fallback for extremely large PDFs.
const LANGDOCK_THRESHOLD = 500;
const DIRECT_THRESHOLD = 500; // direct Anthropic — no rate limit concern
const OPUS_THRESHOLD = 80;    // Opus slower, lower threshold
const effectiveThreshold = (): number => {
  if (isRateLimitedProvider()) return LANGDOCK_THRESHOLD;
  if (config.EXTRACTION_MODEL.includes('opus')) return OPUS_THRESHOLD;
  return DIRECT_THRESHOLD;
};

import type { ExtractionStats } from '../utils/computeStats';

/**
 * Build OCR confidence hints for pages with low-quality OCR.
 * Appended to extractor prompts (NOT pageTexts) so the LLM knows which words are uncertain.
 * Follows DokumenteAnalyse V3 pattern: >= 0.95 auto-accept, 0.80-0.95 flag, < 0.80 reject.
 */
function buildOcrConfidenceHints(ocrResult: OcrResult | null): string {
  if (!ocrResult) return '';

  const hints: string[] = [];
  for (const page of ocrResult.pages) {
    // DokumenteAnalyse V3 threshold: 0.95 (not 0.90) — flag more pages
    if (!page.avgConfidence || page.avgConfidence >= 0.95) continue;
    const lowWords = (page.lowConfidenceWords || [])
      .filter(w => w.confidence < 0.80)
      .slice(0, 20); // Cap per page to avoid bloat
    if (lowWords.length === 0) continue;

    const wordList = lowWords.map(w => `"${w.text}" (${(w.confidence * 100).toFixed(0)}%)`).join(', ');
    hints.push(`Seite ${page.pageNumber} (OCR-Qualität: ${(page.avgConfidence * 100).toFixed(0)}%): Unsichere Wörter: ${wordList}`);
  }

  if (hints.length === 0) return '';
  return `\n--- OCR-QUALITÄTSHINWEISE ---\nDie folgenden Seiten haben niedrige OCR-Qualität. Prüfe die markierten Wörter besonders sorgfältig und korrigiere offensichtliche OCR-Fehler anhand des Kontexts.\n${hints.join('\n')}\n--- ENDE OCR-HINWEISE ---\n`;
}

function isEmpty(field: { wert?: unknown; quelle?: unknown } | null | undefined): boolean {
  if (!field) return true;
  const w = field.wert;
  return w === null || w === undefined || w === '';
}

// ─── Einzelforderungen post-processing helpers ───

/**
 * Parse a German-format number: "50.000,00" → 50000, "1.791,67" → 1791.67, "50000.00" → 50000
 * Handles both German (dot=thousands, comma=decimal) and raw (dot=decimal) formats.
 */
function parseGermanNumber(s: string): number | null {
  s = s.trim().replace(/\s/g, '');
  if (!s) return null;

  // Has both dots and comma → German format: "50.000,00"
  if (s.includes('.') && s.includes(',')) {
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  // Has comma but no dot → German decimal: "1791,67"
  if (s.includes(',') && !s.includes('.')) {
    const n = parseFloat(s.replace(',', '.'));
    return isNaN(n) ? null : n;
  }
  // Has dot(s) → could be German thousands or raw decimal
  // If multiple dots → German thousands: "50.000" = 50000
  if ((s.match(/\./g) || []).length > 1) {
    const n = parseFloat(s.replace(/\./g, ''));
    return isNaN(n) ? null : n;
  }
  // Single dot — ambiguous: "50000.00" (raw) vs "50.000" (German 50k)
  // Heuristic: if exactly 3 digits after dot → German thousands separator
  if (/\.\d{3}$/.test(s) && !/\.\d{1,2}$/.test(s)) {
    const n = parseFloat(s.replace('.', ''));
    return isNaN(n) ? null : n;
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Extract amount components from a titel string and compute the total.
 * Conservative: only computes when the pattern is unambiguous.
 *
 * Pattern 1 — Nennbetrag + Zinsen (Wandeldarlehen):
 *   "Wandeldarlehen: Nennbetrag 50.000,00 EUR; Zinsen 1.791,67 EUR" → 51791.67
 *   "Wandeldarlehensvertrag; Nennbetrag 100000,00 EUR + Zinsen 533,33 EUR" → 100533.33
 *
 * Pattern 2 — Explicit "+" separated components:
 *   "SV-Beiträge 5.104,34 EUR + Säumniszuschläge 387,50 EUR + Mahngebühren 57,50 EUR" → 5549.34
 *
 * Pattern 3 — Single TEUR amount (German accounting, 1 TEUR = 1000 EUR):
 *   "Lohnsteuerverbindlichkeiten: 29 TEUR (zum 31.12.2023)" → 29000
 *   "Kreditkartenverbindlichkeiten: 10 TEUR" → 10000
 */
function computeBetragFromTitel(titel: string): number | null {
  // Pattern 1: Nennbetrag + Zinsen (most Wandeldarlehen)
  const nennbetragMatch = titel.match(/Nennbetrag(?:\s+insgesamt)?\s+([\d.,]+)\s*EUR/i);
  const zinsenMatch = titel.match(/Zinsen\s+([\d.,]+)\s*EUR/i);
  if (nennbetragMatch && zinsenMatch) {
    const nennbetrag = parseGermanNumber(nennbetragMatch[1]);
    const zinsen = parseGermanNumber(zinsenMatch[1]);
    if (nennbetrag !== null && zinsen !== null) {
      // Sanity: if titel also mentions "Zahlung von X EUR" with a DIFFERENT amount,
      // the claim structure is complex — skip automatic computation
      const zahlungMatch = titel.match(/Zahlung\s+von\s+([\d.,]+)\s*EUR/i);
      if (zahlungMatch) {
        const zahlung = parseGermanNumber(zahlungMatch[1]);
        if (zahlung !== null && Math.abs(zahlung - nennbetrag) > 0.01) {
          return null; // Complex claim with partial payment — don't auto-compute
        }
      }
      return Math.round((nennbetrag + zinsen) * 100) / 100;
    }
  }

  // Pattern 2: Explicit "+" separated components ("X EUR + Y EUR + Z EUR")
  // Split by " + " and extract EUR amounts from each part
  if (titel.includes(' + ') || titel.includes(' +\n')) {
    const parts = titel.split(/\s*\+\s*/);
    if (parts.length >= 2) {
      let total = 0;
      let validParts = 0;
      for (const part of parts) {
        const match = part.match(/([\d.,]+)\s*EUR/i);
        if (match) {
          const num = parseGermanNumber(match[1]);
          if (num !== null && num > 0) {
            total += num;
            validParts++;
          }
        }
      }
      if (validParts >= 2 && validParts === parts.length) {
        return Math.round(total * 100) / 100;
      }
    }
  }

  // Pattern 3: Single TEUR amount — matches both "X TEUR" and "TEUR X"
  // Only matches when there's exactly one TEUR value and no EUR values (avoids ambiguity)
  if (/TEUR/i.test(titel) && !/\d[\d.,]*\s*EUR\b/i.test(titel)) {
    // Match both "29 TEUR" and "TEUR 29"
    const allMatches: string[] = [];
    const patternAfter = titel.matchAll(/([\d.,]+)\s*TEUR/gi);
    for (const m of patternAfter) allMatches.push(m[1]);
    const patternBefore = titel.matchAll(/TEUR\s+([\d.,]+)/gi);
    for (const m of patternBefore) allMatches.push(m[1]);
    // Deduplicate (same number might match both patterns)
    const unique = [...new Set(allMatches)];
    if (unique.length === 1) {
      const val = parseGermanNumber(unique[0]);
      if (val !== null && val > 0) {
        return Math.round(val * 1000 * 100) / 100;
      }
    }
  }

  return null;
}

/**
 * Check if a glaeubiger name is actually a number, date, or amount
 * that was incorrectly placed in the name field.
 */
function looksLikeInvalidGlaeubiger(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;

  // Pure number (with optional German formatting): "40.000,00", "751937.5", "503208.33"
  if (/^[\d.,\s]+$/.test(trimmed)) return true;

  // Date-only strings: "05.10.2022", "05.10.2022, 06.10.2023 und 17.11.2023"
  if (/^\d{1,2}\.\d{1,2}\.\d{4}(\s*[,;]\s*\d{1,2}\.\d{1,2}\.\d{4})*(\s+und\s+\d{1,2}\.\d{1,2}\.\d{4})?$/.test(trimmed)) return true;

  // Number followed by date-like patterns (from confused table columns)
  if (/^\d[\d.,]*\s*\n?\d{1,2}\.\d{1,2}\.\d{4}/.test(trimmed)) return true;

  // Page references used as names: "Seite 8, Abschnitt 46 — ..."
  if (/^Seite\s+\d/i.test(trimmed)) return true;

  return false;
}

// ─── Stage 3c: Focused handwriting extraction for Fragebogen pages ───

const FRAGEBOGEN_MARKERS = [
  'fragebogen',
  'ermittlung der wirtschaftlichen',
  'ergänzende betriebliche angaben',
  'vermögensübersicht',
  'ergänzungsblatt',
];

function detectFragebogenPages(pageTexts: string[]): number[] {
  const pages: number[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const lower = pageTexts[i].toLowerCase();
    if (FRAGEBOGEN_MARKERS.some(m => lower.includes(m))) {
      pages.push(i);
    }
  }
  return pages;
}

async function extractPdfPages(pdfBuffer: Buffer, pageIndices: number[]): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const newDoc = await PDFDocument.create();
  const copied = await newDoc.copyPages(srcDoc, pageIndices);
  for (const page of copied) {
    newDoc.addPage(page);
  }
  return Buffer.from(await newDoc.save());
}

const HANDWRITING_PROMPT = `Du bist ein OCR-Spezialist für handschriftlich ausgefüllte deutsche Insolvenz-Fragebögen.

AUFGABE: Lies JEDES handschriftlich ausgefüllte Feld in diesen Formularseiten. Die Formulare sind vorgedruckt mit Feldnamen, und der Antragsteller hat die Werte HANDSCHRIFTLICH eingetragen.

Lies besonders sorgfältig:
- Name, Vorname, Geburtsdatum
- Straße/Hausnummer, PLZ, Ort (Privatanschrift UND Firmenanschrift)
- Telefonnummer, E-Mail-Adresse
- Name der Firma/des Geschäftsbetriebs und dessen Anschrift
- Geschäftszweig/Branche
- Anzahl Mitarbeiter (Azubis, Teilzeit, Aushilfen)
- Steuerberater (Name und Anschrift)
- Sozialversicherungsträger (Krankenkasse)
- Vermieter/Verpächter und Mietbetrag
- Mietrückstände
- Lohnrückstände seit wann, SV-Rückstände seit wann
- Gerichtsvollzieher
- Angekreuzte Checkboxen (☒ = ja, ☐ = nein)
- Beträge in EUR (auch handgeschriebene Zahlen)
- Grundstücke: Lage, Eigentumsanteil, Verkehrswert
- Sicherungsrechte: Gegenstand, Gläubiger, Betrag

Antworte AUSSCHLIESSLICH mit validem JSON. Für jedes gefundene Feld:
{
  "telefon": {"wert": "06545 9121110", "quelle": "Seite X, Fragebogen Telekommunikation"},
  "email": {"wert": "info@example.de", "quelle": "Seite X, Fragebogen E-mail"},
  "betriebsstaette_adresse": {"wert": "Musterstr. 1, 12345 Stadt", "quelle": "Seite X, Anlage 2"},
  "geschaeftszweig": {"wert": "Feinwerkmechanikermeister", "quelle": "Seite X, Anlage 2"},
  "arbeitnehmer_anzahl": {"wert": 2, "quelle": "Seite X, Mitarbeiter"},
  "betriebsrat": {"wert": false, "quelle": "Seite X, Betriebsrat nein angekreuzt"},
  "finanzamt": {"wert": "Finanzamt Simmern-Zell", "quelle": "Seite X"},
  "steuernummer": {"wert": "12/345/67890", "quelle": "Seite X"},
  "steuerberater": {"wert": "Kneip-Daute, Friedrich-Back-Str. 21, 56288 Kastellaun", "quelle": "Seite X"},
  "sozialversicherungstraeger": {"wert": "AOK, UKV Union Krankenversicherung AG", "quelle": "Seite X"},
  "letzter_jahresabschluss": {"wert": "31.12.2023", "quelle": "Seite X"},
  "bankverbindungen": {"wert": "Volksbank Rheinböllen eG, Sparkasse Mittelmosel", "quelle": "Seite X"}
}

Wenn ein Feld leer ist oder nicht lesbar: NICHT aufnehmen. Nur tatsächlich gelesene Werte.`;

async function extractHandwrittenFormFields(
  result: ExtractionResult,
  pdfBuffer: Buffer | null,
  pageTexts: string[]
): Promise<ExtractionResult> {
  const formPages = detectFragebogenPages(pageTexts);
  if (formPages.length === 0) {
    logger.info('No Fragebogen pages detected, skipping handwriting pass');
    return result;
  }

  logger.info('Fragebogen pages detected for handwriting extraction', {
    pages: formPages.map(p => p + 1),
    count: formPages.length,
    mode: pdfBuffer && supportsNativePdf(detectProvider()) ? 'native-pdf' : 'text',
  });

  const handwritingModel = config.EXTRACTION_MODEL;
  const pageMapping = formPages.map((p, i) => `PDF-Seite ${i + 1} = Originalseite ${p + 1}`).join(', ');
  const promptSuffix = `\n\nSeitenzuordnung: ${pageMapping}\nBitte verwende die Originalseitennummern in der quelle.`;

  let response;
  if (pdfBuffer && supportsNativePdf(detectProvider())) {
    // Native PDF mode: send mini-PDF for vision-based handwriting OCR
    const miniPdf = await extractPdfPages(pdfBuffer, formPages);
    const base64 = miniPdf.toString('base64');
    response = await callWithRetry(() => createAnthropicMessage({
      model: handwritingModel,
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
          { type: 'text' as const, text: `${HANDWRITING_PROMPT}${promptSuffix}` },
        ],
      }],
    }));
  } else {
    // Text mode (Langdock): send OCR text of form pages — still catches structured fields
    const formTextBlock = formPages
      .map(p => `=== SEITE ${p + 1} ===\n${pageTexts[p] ?? ''}`)
      .join('\n\n');
    response = await callWithRetry(() => createAnthropicMessage({
      model: handwritingModel,
      max_tokens: 8192,
      temperature: 0,
      messages: [{
        role: 'user' as const,
        content: `${HANDWRITING_PROMPT}${promptSuffix}\n\n--- FORMULARE (OCR-Text) ---\n\n${formTextBlock}`,
      }],
    }));
  }

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');

  let parsed: Record<string, { wert: unknown; quelle: string }>;
  try {
    const jsonStr = extractJsonFromText(text);
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // JSON likely truncated by max_tokens — try jsonrepair
      const { jsonrepair } = await import('jsonrepair');
      parsed = JSON.parse(jsonrepair(jsonStr));
      logger.info('Handwriting JSON per jsonrepair repariert');
    }
  } catch (err) {
    logger.warn('Handwriting extraction JSON parse failed', {
      error: err instanceof Error ? err.message : String(err),
      sample: text.slice(0, 300),
    });
    return result;
  }

  // Merge into result — only fill fields that are currently empty
  const s = result.schuldner;
  let merged = 0;

  const mergeField = (target: { wert: unknown; quelle: string } | undefined, key: string) => {
    const source = parsed[key];
    if (!source?.wert) return;
    if (!target) {
      logger.warn('Handwriting merge: target undefined, cannot write', { key });
      return;
    }
    if (target.wert === null || target.wert === undefined || target.wert === '') {
      target.wert = source.wert as string;
      target.quelle = `${source.quelle} (Handschrift-Extraktion)`;
      merged++;
    }
  };

  mergeField(s.telefon, 'telefon');
  mergeField(s.mobiltelefon, 'mobiltelefon');
  mergeField(s.email, 'email');
  mergeField(s.betriebsstaette_adresse, 'betriebsstaette_adresse');
  mergeField(s.geschaeftszweig, 'geschaeftszweig');
  mergeField(s.unternehmensgegenstand, 'unternehmensgegenstand');
  mergeField(s.finanzamt, 'finanzamt');
  mergeField(s.steuernummer, 'steuernummer');
  mergeField(s.ust_id, 'ust_id');
  mergeField(s.steuerberater, 'steuerberater');
  mergeField(s.sozialversicherungstraeger, 'sozialversicherungstraeger');
  mergeField(s.letzter_jahresabschluss, 'letzter_jahresabschluss');
  mergeField(s.bankverbindungen, 'bankverbindungen');
  mergeField(s.aktuelle_adresse, 'aktuelle_adresse');
  mergeField(s.firma, 'firma');
  mergeField(s.familienstand, 'familienstand');
  mergeField(s.geschlecht, 'geschlecht');

  // Numeric fields
  if (parsed.arbeitnehmer_anzahl?.wert != null && isEmpty(s.arbeitnehmer_anzahl)) {
    s.arbeitnehmer_anzahl = {
      wert: Number(parsed.arbeitnehmer_anzahl.wert) || 0,
      quelle: `${parsed.arbeitnehmer_anzahl.quelle} (Handschrift-Extraktion)`,
    };
    merged++;
  }
  if (parsed.betriebsrat?.wert != null && isEmpty(s.betriebsrat)) {
    s.betriebsrat = {
      wert: parsed.betriebsrat.wert === true || parsed.betriebsrat.wert === 'true' || parsed.betriebsrat.wert === 'ja',
      quelle: `${parsed.betriebsrat.quelle} (Handschrift-Extraktion)`,
    };
    merged++;
  }

  logger.info('Handwriting extraction completed', {
    fieldsFound: Object.keys(parsed).length,
    merged,
    formPages: formPages.length,
  });

  return result;
}

// ─── Post-processing: apply transparent defaults and inferences ───

// Common German male/female first names for gender inference
const MALE_NAMES = new Set(['alexander','andreas','bernd','christian','daniel','david','dirk','erik','frank','hans','heinrich','jan','jens','jörg','karl','klaus','lars','lukas','markus','martin','matthias','max','michael','nicolas','oliver','patrick','paul','peter','philipp','ralf','robert','stefan','sven','thomas','tobias','uwe','werner','wolfgang']);
const FEMALE_NAMES = new Set(['alexandra','andrea','angelika','anna','annette','barbara','birgit','brigitte','carmen','charlotte','claudia','daniela','elke','eva','franziska','gabriele','heike','ines','julia','karen','kathrin','katja','kerstin','klara','laura','lisa','maria','marion','martina','monika','nadine','nicole','petra','sabine','sandra','sarah','silke','simone','stefanie','susanne','tanja','ulrike','ursula','yvonne']);

function postProcessDefaults(result: ExtractionResult): ExtractionResult {
  const DEFAULT_QUELLE = 'Standard-Annahme (nicht in Akte erwähnt)';

  // 1. Boolean defaults: internationaler_bezug / eigenverwaltung → false only when null/undefined (not when explicitly set)
  if (result.verfahrensdaten.internationaler_bezug?.wert == null) {
    result.verfahrensdaten.internationaler_bezug = { wert: false, quelle: DEFAULT_QUELLE };
  }
  if (result.verfahrensdaten.eigenverwaltung?.wert == null) {
    result.verfahrensdaten.eigenverwaltung = { wert: false, quelle: DEFAULT_QUELLE };
  }

  // 2. Gender inference from first name
  const s = result.schuldner;
  if (isEmpty(s.geschlecht) && s.vorname?.wert) {
    const vn = String(s.vorname.wert).toLowerCase().trim().split(/[\s-]/)[0];
    if (MALE_NAMES.has(vn)) {
      s.geschlecht = { wert: 'männlich', quelle: `Abgeleitet aus Vorname "${s.vorname.wert}"` };
    } else if (FEMALE_NAMES.has(vn)) {
      s.geschlecht = { wert: 'weiblich', quelle: `Abgeleitet aus Vorname "${s.vorname.wert}"` };
    }
  }

  // 3. Betriebsstätte fallback: if empty but firma address available in other fields
  if (isEmpty(s.betriebsstaette_adresse) && s.firma?.wert) {
    // Check if aktuelle_adresse differs from betriebsstaette — for nat. Personen,
    // betriebsstaette might be in unternehmensgegenstand or zusammenfassung
    const zf = result.zusammenfassung ?? [];
    for (const z of zf) {
      if (!z.wert) continue;
      // Look for patterns like "Zur Oberen Heide 11" or business address mentions
      const match = z.wert.match(/(?:Betriebsstätte|Betrieb|Firmensitz|Geschäftssitz|Unternehmen)[:\s]+([^,]+,\s*\d{5}\s+\w+)/i);
      if (match) {
        s.betriebsstaette_adresse = { wert: match[1].trim(), quelle: z.quelle || 'Zusammenfassung' };
        break;
      }
    }
  }

  // 4. Betriebsrat default: false when not mentioned (only for entities/Einzelunternehmen with employees)
  if (s.firma?.wert && isEmpty(s.betriebsrat)) {
    s.betriebsrat = { wert: false, quelle: DEFAULT_QUELLE };
  }

  // 5. Arbeitnehmer: try to infer from betroffene_arbeitnehmer if schuldner field is empty
  if (isEmpty(s.arbeitnehmer_anzahl)) {
    const an = result.forderungen?.betroffene_arbeitnehmer;
    if (an?.length) {
      let total = 0;
      for (const a of an) {
        if (a && typeof a === 'object' && 'anzahl' in a) total += (a as { anzahl: number }).anzahl || 0;
      }
      if (total > 0) {
        s.arbeitnehmer_anzahl = { wert: total, quelle: 'Abgeleitet aus betroffene Arbeitnehmer' };
      }
    }
  }

  // 6. Compute freie_masse per aktiva position (never trust LLM arithmetic)
  if (result.aktiva?.positionen?.length) {
    for (const pos of result.aktiva.positionen) {
      const wert = typeof pos.geschaetzter_wert?.wert === 'number' ? pos.geschaetzter_wert.wert : 0;
      const absonderung = typeof pos.absonderung?.wert === 'number' ? pos.absonderung.wert : 0;
      const aussonderung = typeof pos.aussonderung?.wert === 'number' ? pos.aussonderung.wert : 0;
      const computed = Math.max(0, Math.round((wert - absonderung - aussonderung) * 100) / 100);
      pos.freie_masse = { wert: computed, quelle: 'Berechnet: geschaetzter_wert - absonderung - aussonderung' };
    }
  }

  // 7. Parse "ca. X" string amounts in einzelforderungen betrag
  if (result.forderungen?.einzelforderungen) {
    for (const ef of result.forderungen.einzelforderungen) {
      const betragWert = ef.betrag?.wert;
      if (typeof betragWert === 'string') {
        // Parse strings like "ca. 25.000", "ca 35000", "~15.000"
        const cleaned = String(betragWert).replace(/^(ca\.?\s*|~\s*|circa\s*|etwa\s*)/i, '').replace(/\./g, '').replace(',', '.').trim();
        const num = parseFloat(cleaned);
        if (!isNaN(num) && num > 0) {
          (ef.betrag as { wert: unknown }).wert = num;
        }
      }
    }
  }

  // 7b. Compute betrag from titel components (Nennbetrag + Zinsen etc.)
  // The LLM is instructed NOT to add amounts — this layer does it correctly
  if (result.forderungen?.einzelforderungen) {
    for (const ef of result.forderungen.einzelforderungen) {
      const titel = String(ef.titel?.wert ?? '');
      if (!titel) continue;

      const computed = computeBetragFromTitel(titel);
      if (computed === null) continue;

      const currentBetrag = ef.betrag?.wert;
      if (currentBetrag == null || currentBetrag === 0) {
        // betrag is null/0 — use computed value
        ef.betrag = { wert: computed, quelle: ef.titel?.quelle ? `Berechnet aus Teilbeträgen (${ef.titel.quelle})` : 'Berechnet aus Teilbeträgen' };
      } else if (typeof currentBetrag === 'number' && currentBetrag > 0) {
        // betrag is set — check for *100 multiplication error (lost decimal)
        const ratio = currentBetrag / computed;
        if (ratio > 90 && ratio < 110) {
          // Looks like betrag ≈ computed * 100 → LLM dropped the decimal point
          ef.betrag = { wert: computed, quelle: ef.titel?.quelle ? `Korrigiert aus Teilbeträgen (${ef.titel.quelle})` : 'Korrigiert aus Teilbeträgen' };
        }
      }
    }
  }

  // 7c. Validate glaeubiger names — reject numbers, dates, and amounts
  if (result.forderungen?.einzelforderungen) {
    for (const ef of result.forderungen.einzelforderungen) {
      const name = String(ef.glaeubiger?.wert ?? '').trim();
      if (!name || name === '—') continue;

      if (looksLikeInvalidGlaeubiger(name)) {
        logger.warn(`Einzelforderung glaeubiger rejected (looks like number/date): "${name}"`);
        (ef.glaeubiger as { wert: unknown }).wert = null;
        ef.glaeubiger.quelle = '';
      }
    }
  }

  // 8. Recompute forderungen sums from einzelforderungen (never trust model arithmetic)
  if (result.forderungen?.einzelforderungen?.length) {
    const ef = result.forderungen.einzelforderungen;
    const safeNum = (v: unknown): number => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        const cleaned = v.replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
        const n = parseFloat(cleaned);
        return isNaN(n) ? 0 : n;
      }
      return 0;
    };

    const total = ef.reduce((s, f) => s + safeNum(f.betrag?.wert), 0);
    if (total > 0) {
      result.forderungen.gesamtforderungen = { wert: Math.round(total * 100) / 100, quelle: 'Berechnet aus Einzelforderungen' };
    }

    // Also fix individual betrag values that are strings
    for (const f of ef) {
      if (typeof f.betrag?.wert === 'string') {
        const n = safeNum(f.betrag.wert);
        if (n > 0) (f.betrag as { wert: unknown }).wert = n;
      }
    }
  }

  // 9. ALWAYS recompute all derived totals — never trust LLM arithmetic
  // 9a. summe_aktiva from positions (always overwrite, even if non-null)
  if (result.aktiva?.positionen?.length) {
    const total = result.aktiva.positionen.reduce((sum, p) => {
      const w = p.geschaetzter_wert?.wert;
      return sum + (typeof w === 'number' ? w : 0);
    }, 0);
    result.aktiva.summe_aktiva = { wert: Math.round(total * 100) / 100, quelle: 'Berechnet aus Einzelpositionen' };
  }

  // 9b. gesamtpotenzial from anfechtung vorgaenge (always overwrite)
  if (result.anfechtung?.vorgaenge?.length) {
    const total = result.anfechtung.vorgaenge.reduce((sum, v) => {
      const w = v.betrag?.wert;
      return sum + (typeof w === 'number' ? w : 0);
    }, 0);
    result.anfechtung.gesamtpotenzial = { wert: Math.round(total * 100) / 100, quelle: 'Berechnet aus Einzelvorgängen' };
  }

  logger.info('Post-processing defaults applied');
  return result;
}

// Fields that are only relevant for juristische Personen / Gesellschaften — skip for natürliche Person
const ENTITY_ONLY_FIELDS = new Set([
  'satzungssitz', 'verwaltungssitz', 'stammkapital', 'geschaeftsfuehrer',
  'prokurist', 'gruendungsdatum', 'hr_eintragung_datum', 'groessenklasse_hgb',
  'dundo_versicherung', 'steuerliche_organschaft', 'gesellschafter',
]);

// Fields that are only relevant for natürliche Personen — skip for entities
const PERSON_ONLY_FIELDS = new Set([
  'geburtsort', 'geburtsland', 'staatsangehoerigkeit',
]);

// Extended/optional fields that should not count as "missing" when empty
const OPTIONAL_STATS_FIELDS = new Set([
  'mobiltelefon', 'ust_id', 'wirtschaftsjahr', 'ust_versteuerung',
  'insolvenzsonderkonto', 'geschaeftszweig', 'unternehmensgegenstand',
  'internationaler_bezug', 'eigenverwaltung', 'verfahrensstadium', 'verfahrensart',
  'richter', 'zustellungsdatum_schuldner',
]);

function isJuristischePersonResult(result: ExtractionResult): boolean {
  const rf = String(result.schuldner?.rechtsform?.wert ?? '').toLowerCase();
  return /gmbh|ug\b|ag\b|se\b|kg\b|ohg|gbr|partg|e\.?\s?v|stiftung|genossenschaft|kgaa/i.test(rf);
}

export type ProgressCallback = (message: string, percent: number) => void;

// ─── Anchor → Candidates helper ───

/**
 * Convert an AnchorPacket into ExtractionCandidate[] so they can be fed
 * into the same reducer pipeline as scalar pack results.
 *
 * - Natürliche Person: splits debtor_canonical_name on comma into name + vorname
 * - Juristische Person / Personengesellschaft: maps to firma + rechtsform
 */
function anchorToCandidates(anchor: AnchorPacket): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  const packId = 'anchor_core';
  const segmentType = 'beschluss' as const;

  function add(fieldPath: string, wert: unknown, quelle: string) {
    if (wert === null || wert === undefined || wert === '') return;
    candidates.push({ fieldPath, wert, quelle, page: 1, segmentType, packId });
  }

  // Verfahrensdaten
  add('verfahrensdaten.aktenzeichen', anchor.aktenzeichen, 'Seite 1, Beschluss (Anker-Pass)');
  add('verfahrensdaten.gericht', anchor.gericht, 'Seite 1, Beschluss (Anker-Pass)');
  add('verfahrensdaten.beschlussdatum', anchor.beschlussdatum, 'Seite 1, Beschluss (Anker-Pass)');
  add('verfahrensdaten.antragsdatum', anchor.antragsdatum, 'Seite 1, Beschluss (Anker-Pass)');

  // Schuldner identity — depends on debtor type
  if (anchor.debtor_type === 'natuerliche_person') {
    if (anchor.debtor_canonical_name) {
      // Format: "Nachname, Vorname" → split
      const commaIdx = anchor.debtor_canonical_name.indexOf(',');
      if (commaIdx > 0) {
        const name = anchor.debtor_canonical_name.slice(0, commaIdx).trim();
        const vorname = anchor.debtor_canonical_name.slice(commaIdx + 1).trim();
        add('schuldner.name', name, 'Seite 1, Beschluss (Anker-Pass)');
        add('schuldner.vorname', vorname, 'Seite 1, Beschluss (Anker-Pass)');
      } else {
        // No comma — use as full name
        add('schuldner.name', anchor.debtor_canonical_name, 'Seite 1, Beschluss (Anker-Pass)');
      }
    }
  } else {
    // Juristische Person / Personengesellschaft → firma + rechtsform
    add('schuldner.firma', anchor.debtor_canonical_name, 'Seite 1, Beschluss (Anker-Pass)');
    add('schuldner.rechtsform', anchor.debtor_rechtsform, 'Seite 1, Beschluss (Anker-Pass)');
  }

  // Antragsteller
  add('antragsteller.name', anchor.applicant_canonical_name, 'Seite 1, Beschluss (Anker-Pass)');

  // Gutachter
  add('gutachterbestellung.gutachter_name', anchor.gutachter_name, 'Seite 1, Beschluss (Anker-Pass)');

  return candidates;
}

// ─── Field Pack extraction pipeline ───

/**
 * Anchor + Field Pack extraction — replaces monolithic extractComprehensive().
 * Makes 1 anchor call + 4-5 scalar pack calls (each 10-25K tokens) instead of
 * one massive 150K+ token call.
 */
async function extractWithFieldPacks(
  pageTexts: string[],
  segments: DocumentSegment[],
  documentMap: string,
  ocrResult: OcrResult | null,
  report: (msg: string, pct: number) => void,
): Promise<ExtractionResult> {
  const totalPages = pageTexts.length;

  // 1. Route segments for anchor pack
  const anchorRouting = routeSegmentsToFieldPacks(segments, totalPages, [ANCHOR_PACK]);
  const anchorPages = anchorRouting[ANCHOR_PACK.id]?.pages ??
    Array.from({ length: Math.min(8, totalPages) }, (_, i) => i + 1);

  // 2. Anchor pass
  report('Kernidentifikatoren werden extrahiert… (Anker-Pass)', 32);
  const anchor = await extractAnchor(pageTexts, anchorPages);

  // 3. Get packs for this debtor type
  const scalarPacks = getPacksForDebtorType(anchor.debtor_type);
  const scalarRouting = routeSegmentsToFieldPacks(segments, totalPages, scalarPacks);

  // 4. Execute scalar packs sequentially
  const allCandidates: ExtractionCandidate[] = [];

  // Add anchor results as candidates
  allCandidates.push(...anchorToCandidates(anchor));

  for (let i = 0; i < scalarPacks.length; i++) {
    const pack = scalarPacks[i];
    const packRoute = scalarRouting[pack.id] ?? { pages: [], segmentTypes: [] };
    const pct = 35 + Math.round((i / scalarPacks.length) * 15);
    report(`${pack.name}… (Pack ${i + 1}/${scalarPacks.length})`, pct);

    const candidates = await executeFieldPack(
      pack, pageTexts, packRoute.pages, packRoute.segmentTypes, anchor, ocrResult,
    );
    allCandidates.push(...candidates);
  }

  // 5. Reduce to ExtractionResult
  logger.info('Kandidaten-Zusammenführung', { totalCandidates: allCandidates.length, packs: scalarPacks.length + 1 });
  return buildResultFromCandidates(allCandidates);
}

export async function processExtraction(
  pdfBuffer: Buffer,
  filename: string,
  fileSize: number,
  userId: number,
  onProgress?: ProgressCallback,
  modelOverride?: string
): Promise<{ id: number; result: ExtractionResult; stats: ExtractionStats; processingTimeMs: number }> {
  // Pro mode: temporarily swap EXTRACTION_MODEL for this call only
  const originalModel = config.EXTRACTION_MODEL;
  if (modelOverride) {
    (config as Record<string, unknown>).EXTRACTION_MODEL = modelOverride;
    logger.info('Pro-Modus aktiviert', { model: modelOverride });
  }
  try {
  const rawProgress = onProgress ?? (() => {});
  // report() will be assigned after extractionId is known
  let report: (message: string, percent: number) => void = rawProgress;
  const db = getDb();
  const startTime = Date.now();
  const deregisterExtraction = registerExtraction();

  // Wrap progress callback to also persist to DB
  const persistProgress = (extractionId: number, message: string, percent: number) => {
    try {
      getDb().prepare('UPDATE extractions SET progress_message = ?, progress_percent = ? WHERE id = ?')
        .run(message, percent, extractionId);
    } catch { /* non-critical */ }
  };

  // Create extraction record
  const insertResult = db.prepare(
    'INSERT INTO extractions (user_id, filename, file_size, status) VALUES (?, ?, ?, ?)'
  ).run(userId, filename, fileSize, 'processing');
  const extractionId = Number(insertResult.lastInsertRowid);

  // Now that we have extractionId, augment report to persist progress to DB
  report = (message: string, percent: number) => {
    rawProgress(message, percent);
    persistProgress(extractionId, message, percent);
  };

  try {
    // Save PDF to disk for later viewing (stored alongside DB in /data volume)
    const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
    const fs = await import('fs');
    const extractionPdfDir = path.join(pdfDir, String(extractionId));
    if (!fs.existsSync(extractionPdfDir)) fs.mkdirSync(extractionPdfDir, { recursive: true });
    fs.writeFileSync(path.join(extractionPdfDir, '0_gerichtsakte.pdf'), pdfBuffer);
    logger.info('PDF gespeichert', { extractionId, path: path.join(extractionPdfDir, '0_gerichtsakte.pdf') });

    report('Seitentext wird extrahiert…', 8);

    // Always extract text per page — needed for analysis and verification
    let pageTexts = await extractTextPerPage(pdfBuffer);
    const pageCount = pageTexts.length;
    logger.info('PDF Seitenanzahl ermittelt', { pageCount });

    // Track OCR result for confidence hints
    let ocrResult: OcrResult | null = null;

    // If scanned PDF (near-zero text), run Azure Document Intelligence OCR
    if (isScannedPdf(pageTexts) && isOcrConfigured()) {
      report('Gescanntes PDF erkannt — OCR wird durchgeführt…', 10);
      logger.info('Gescanntes PDF erkannt, starte Azure Document Intelligence OCR', {
        avgCharsPerPage: Math.round(pageTexts.reduce((s, t) => s + t.length, 0) / pageTexts.length),
      });
      try {
        ocrResult = await ocrPdf(pdfBuffer);
        // Build pageTexts from clean OCR line text only.
        // Table structures and confidence data are available in ocrResult
        // but NOT injected into pageTexts — they bloat the prompt (129 tables
        // added ~75K tokens on the Geldt PDF, causing Stage 2a to fail).
        // Claude sees the PDF images directly via native PDF mode.
        const ocrPageTexts = new Array<string>(pageCount).fill('');
        for (const page of ocrResult.pages) {
          if (page.pageNumber >= 1 && page.pageNumber <= pageCount) {
            ocrPageTexts[page.pageNumber - 1] = page.text;
          }
        }
        pageTexts = removeWatermarksFromTexts(ocrPageTexts);
        logger.info('OCR abgeschlossen', {
          totalChars: ocrResult.totalChars,
          pagesWithText: ocrResult.pages.filter(p => p.text.length > 0).length,
          tablesDetected: ocrResult.pages.reduce((s, p) => s + (p.tables?.length || 0), 0),
        });

        // Add invisible OCR text layer to PDF for frontend text highlighting
        try {
          const { addOcrTextLayer } = await import('./ocrLayerService');
          const searchablePdf = addOcrTextLayer(pdfBuffer, ocrResult);
          if (searchablePdf !== pdfBuffer) {
            pdfBuffer = searchablePdf;
            // Re-save PDF with text layer so frontend can highlight/search
            const ocrPdfDir = path.join(path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs'), String(extractionId));
            (await import('fs')).writeFileSync(path.join(ocrPdfDir, '0_gerichtsakte.pdf'), pdfBuffer);
            logger.info('PDF mit OCR-Textlayer gespeichert', { extractionId });
          }
        } catch (layerErr) {
          logger.warn('OCR-Textlayer fehlgeschlagen', {
            error: layerErr instanceof Error ? layerErr.message : String(layerErr),
          });
        }
      } catch (err) {
        logger.error('OCR fehlgeschlagen, verwende Original-Text', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with original (sparse) pageTexts — extraction still works via native PDF vision
      }
    }

    // Build OCR confidence hints (empty string for digital PDFs)
    const ocrHints = buildOcrConfidenceHints(ocrResult);
    if (ocrHints) {
      logger.info('OCR-Qualitätshinweise erstellt', {
        pagesWithLowConfidence: ocrResult!.pages.filter(p => p.avgConfidence && p.avgConfidence < 0.90).length,
      });
    }

    report(`${pageCount} Seiten erkannt — Dokumentstruktur wird analysiert… (Stufe 1/3)`, 15);

    // Stage 1: Analyze document structure → text map + parsed segments
    const { mapText: rawDocumentMap, segments } = await analyzeDocumentStructure(pageTexts);
    // Append OCR confidence hints to document map — flows into all extractor prompts
    const documentMap = ocrHints ? `${rawDocumentMap}${ocrHints}` : rawDocumentMap;

    report('Daten werden extrahiert… (Stufe 2/3)', 30);

    // Stage 2: Extract data — single comprehensive call for normal PDFs,
    // chunked fallback with separate aktiva/anfechtung for very large PDFs
    let result: ExtractionResult;

    const provider = detectProvider();
    logProviderConfig();

    if (provider === 'openai') {
      // OpenAI/GPT extraction — vision via images, auto-chunks for large files
      report(`GPT-Extraktion (${pageCount} S.)… (Stufe 2a/3)`, 35);
      result = await extractWithOpenAI(pdfBuffer, pageTexts, EXTRACTION_PROMPT, documentMap, segments);

      // Stage 2b: Run Anthropic-based focused passes (same as Sonnet pipeline)
      // GPT handles base extraction; Anthropic models handle detail extraction
      const routing = classifySegmentsForExtraction(segments, pageCount);
      logger.info('Seitenklassifizierung (GPT + focused passes)', {
        forderungenPages: routing.forderungenPages.length,
        aktivaPages: routing.aktivaPages.length,
        anfechtungPages: routing.anfechtungPages.length,
      });

      report('Detailanalyse (Forderungen, Aktiva, Anfechtung)… (Stufe 2b/3)', 50);
      const [forderungenResult, aktivaResult, anfechtungResult] = await Promise.allSettled([
        extractForderungen(pageTexts, routing.forderungenPages, documentMap, ocrResult, pdfBuffer),
        extractAktiva(pageTexts, documentMap, result, routing.aktivaPages, ocrResult, pdfBuffer),
        analyzeAnfechtung(pageTexts, documentMap, result, routing.anfechtungPages, ocrResult, pdfBuffer),
      ]);

      if (forderungenResult.status === 'fulfilled' && forderungenResult.value) {
        result.forderungen = forderungenResult.value;
      } else if (forderungenResult.status === 'rejected') {
        logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: forderungenResult.reason instanceof Error ? forderungenResult.reason.message : String(forderungenResult.reason) });
      }
      if (aktivaResult.status === 'fulfilled' && aktivaResult.value) {
        result.aktiva = aktivaResult.value;
      } else if (aktivaResult.status === 'rejected') {
        logger.warn('Aktiva-Extraktion fehlgeschlagen', { error: aktivaResult.reason instanceof Error ? aktivaResult.reason.message : String(aktivaResult.reason) });
      }
      if (anfechtungResult.status === 'fulfilled' && anfechtungResult.value) {
        result.anfechtung = anfechtungResult.value;
      } else if (anfechtungResult.status === 'rejected') {
        logger.warn('Anfechtungsanalyse fehlgeschlagen', { error: anfechtungResult.reason instanceof Error ? anfechtungResult.reason.message : String(anfechtungResult.reason) });
      }
    } else if (pageCount <= effectiveThreshold()) {
      // Normal PDFs (≤50 pages): monolithic extraction (best quality)
      report(`Basisanalyse (${pageCount} S.)… (Stufe 2a/3)`, 35);
      result = await extractComprehensive(pdfBuffer, pageTexts, documentMap);

      // Classify pages by domain for focused extraction
      const routing = classifySegmentsForExtraction(segments, pageCount);
      logger.info('Seitenklassifizierung', {
        forderungenPages: routing.forderungenPages.length,
        aktivaPages: routing.aktivaPages.length,
        anfechtungPages: routing.anfechtungPages.length,
      });

      // Run focused extractors in parallel (all use cheap Haiku)
      report('Detailanalyse (Forderungen, Aktiva, Anfechtung)… (Stufe 2b/3)', 50);

      if (isRateLimitedProvider()) {
        // Rate-limited: serialize with delays
        logger.info('Rate-limited provider: Detailanalysen seriell');
        const forderungenResult = await extractForderungen(pageTexts, routing.forderungenPages, documentMap, ocrResult, pdfBuffer)
          .catch(err => { logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });
        await new Promise(r => setTimeout(r, 62_000));
        const aktivaResult = await extractAktiva(pageTexts, documentMap, result, routing.aktivaPages, ocrResult, pdfBuffer)
          .catch(err => { logger.warn('Aktiva-Extraktion fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });
        await new Promise(r => setTimeout(r, 62_000));
        const anfechtungResult = await analyzeAnfechtung(pageTexts, documentMap, result, routing.anfechtungPages, ocrResult, pdfBuffer)
          .catch(err => { logger.warn('Anfechtungsanalyse fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });

        if (forderungenResult) result.forderungen = forderungenResult;
        if (aktivaResult) result.aktiva = aktivaResult;
        if (anfechtungResult) result.anfechtung = anfechtungResult;
      } else {
        // Normal: run all three in parallel
        const [forderungenResult, aktivaResult, anfechtungResult] = await Promise.allSettled([
          extractForderungen(pageTexts, routing.forderungenPages, documentMap, ocrResult, pdfBuffer),
          extractAktiva(pageTexts, documentMap, result, routing.aktivaPages, ocrResult, pdfBuffer),
          analyzeAnfechtung(pageTexts, documentMap, result, routing.anfechtungPages, ocrResult, pdfBuffer),
        ]);

        if (forderungenResult.status === 'fulfilled' && forderungenResult.value) {
          result.forderungen = forderungenResult.value;
        } else if (forderungenResult.status === 'rejected') {
          logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: forderungenResult.reason instanceof Error ? forderungenResult.reason.message : String(forderungenResult.reason) });
        }
        if (aktivaResult.status === 'fulfilled' && aktivaResult.value) {
          result.aktiva = aktivaResult.value;
        } else if (aktivaResult.status === 'rejected') {
          logger.warn('Aktiva-Extraktion fehlgeschlagen', { error: aktivaResult.reason instanceof Error ? aktivaResult.reason.message : String(aktivaResult.reason) });
        }
        if (anfechtungResult.status === 'fulfilled' && anfechtungResult.value) {
          result.anfechtung = anfechtungResult.value;
        } else if (anfechtungResult.status === 'rejected') {
          logger.warn('Anfechtungsanalyse fehlgeschlagen', { error: anfechtungResult.reason instanceof Error ? anfechtungResult.reason.message : String(anfechtungResult.reason) });
        }
      }
    } else {
      // Fallback: chunked extraction for very large PDFs
      const chunkInfo = segments.length > 0
        ? `dokumentbasiertes Chunking (${segments.length} Segmente)`
        : 'seitenbasiertes Chunking';
      logger.info(`Großes PDF (${pageCount} S.) — verwende Anker + Feldpakete (${chunkInfo})`);
      report(`Großes PDF (${pageCount} S.) — Anker + Feldpakete… (Stufe 2/3)`, 35);
      result = await extractWithFieldPacks(pageTexts, segments, documentMap, ocrResult, report);

      // For chunked extraction, run aktiva + anfechtung + forderungen separately
      // On rate-limited providers, serialize with delay
      report('Zusatzanalysen…', 55);
      let aktivaResult: PromiseSettledResult<Awaited<ReturnType<typeof extractAktiva>>>;
      let anfechtungResult: PromiseSettledResult<Awaited<ReturnType<typeof analyzeAnfechtung>>>;
      let forderungenChunkedResult: PromiseSettledResult<Awaited<ReturnType<typeof extractForderungen>>>;

      // Classify pages for forderungen routing even in chunked mode
      const chunkedRouting = classifySegmentsForExtraction(segments, pageCount);

      if (isRateLimitedProvider()) {
        logger.info('Rate-limited provider: Zusatzanalysen seriell mit Pause');
        report('Aktiva-Analyse… (Rate-Limit-Modus)', 55);
        aktivaResult = await extractAktiva(pageTexts, documentMap, result, chunkedRouting.aktivaPages, ocrResult, pdfBuffer)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
        await new Promise(r => setTimeout(r, 62_000));
        report('Anfechtungsanalyse…', 60);
        anfechtungResult = await analyzeAnfechtung(pageTexts, documentMap, result, chunkedRouting.anfechtungPages, ocrResult, pdfBuffer)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
        await new Promise(r => setTimeout(r, 62_000));
        report('Forderungen-Analyse…', 62);
        forderungenChunkedResult = await extractForderungen(pageTexts, chunkedRouting.forderungenPages, documentMap, ocrResult, pdfBuffer)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
      } else {
        [aktivaResult, anfechtungResult, forderungenChunkedResult] = await Promise.allSettled([
          extractAktiva(pageTexts, documentMap, result, chunkedRouting.aktivaPages, ocrResult, pdfBuffer),
          analyzeAnfechtung(pageTexts, documentMap, result, chunkedRouting.anfechtungPages, ocrResult, pdfBuffer),
          extractForderungen(pageTexts, chunkedRouting.forderungenPages, documentMap, ocrResult, pdfBuffer),
        ]);
      }

      if (aktivaResult.status === 'fulfilled' && aktivaResult.value) {
        result.aktiva = aktivaResult.value;
      } else if (aktivaResult.status === 'rejected') {
        logger.warn('Aktiva extraction failed, continuing without', { error: aktivaResult.reason instanceof Error ? aktivaResult.reason.message : String(aktivaResult.reason) });
      }

      if (anfechtungResult.status === 'fulfilled' && anfechtungResult.value) {
        result.anfechtung = anfechtungResult.value;
      } else if (anfechtungResult.status === 'rejected') {
        logger.warn('Anfechtungsanalyse failed, continuing without', { error: anfechtungResult.reason instanceof Error ? anfechtungResult.reason.message : String(anfechtungResult.reason) });
      }

      if (forderungenChunkedResult.status === 'fulfilled' && forderungenChunkedResult.value) {
        result.forderungen = forderungenChunkedResult.value;
      } else if (forderungenChunkedResult.status === 'rejected') {
        logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: forderungenChunkedResult.reason instanceof Error ? forderungenChunkedResult.reason.message : String(forderungenChunkedResult.reason) });
      }
    }

    report('Quellenangaben werden verifiziert… (Stufe 3/3)', 65);

    // Stage 3: Verify and correct against actual page texts + document structure
    const verifyResult = await semanticVerify(result, pageTexts, documentMap);
    result = verifyResult.result;

    // Stage 3b: Targeted re-extraction for scalar fields removed by verifier
    // Array elements (forderungen[N], aktiva[N], anfechtung[N]) are NOT re-extracted —
    // they come from focused passes and should not be second-guessed.
    const scalarRemovedPaths = verifyResult.removedPaths.filter(p =>
      !p.match(/\beinzelforderungen\[/) && !p.match(/\bpositionen\[/) && !p.match(/\bvorgaenge\[/)
    );
    if (scalarRemovedPaths.length > 0 && scalarRemovedPaths.length <= 20) {
      report('Fehlende Felder werden nachextrahiert…', 82);
      logger.info('Targeted re-extraction', { removedPaths: scalarRemovedPaths });
      try {
        const reExtractPrompt = `Du bist ein Extraktionsassistent. Die folgenden Felder wurden bei der vorherigen Extraktion als fehlerhaft erkannt und entfernt. Prüfe die Akte erneut SORGFÄLTIG und extrahiere NUR diese spezifischen Felder. Antworte mit einem JSON-Objekt das NUR die gefundenen Felder enthält (Pfad als Key, {wert, quelle} als Value). Wenn ein Feld wirklich nicht in der Akte steht, lasse es weg.

Gesuchte Felder: ${scalarRemovedPaths.join(', ')}

Antworte NUR mit validem JSON: {"feldpfad": {"wert": "...", "quelle": "Seite X, ..."}, ...}`;

        // Only send pages that are likely relevant — extract page numbers from removed field quellen + nearby pages
        const rePages = new Set<number>();
        for (const rp of scalarRemovedPaths) {
          // Try to find the quelle for this field to get its page number
          const parts = rp.replace(/\[\d+\]/, '').split('.');
          let obj: unknown = result;
          for (const part of parts) {
            if (obj && typeof obj === 'object') obj = (obj as Record<string, unknown>)[part];
          }
          if (obj && typeof obj === 'object' && 'quelle' in obj) {
            const match = String((obj as { quelle: unknown }).quelle).match(/Seite\s+(\d+)/i);
            if (match) {
              const p = parseInt(match[1], 10);
              // Add the page and neighbors (±2) for context
              for (let i = Math.max(1, p - 2); i <= Math.min(pageTexts.length, p + 2); i++) rePages.add(i);
            }
          }
        }
        // Fallback: if no pages found, use first 30 pages (cover + key docs)
        if (rePages.size === 0) {
          for (let i = 1; i <= Math.min(30, pageTexts.length); i++) rePages.add(i);
        }
        const sortedRePages = [...rePages].sort((a, b) => a - b);
        logger.info('Re-extraction page budget', { pages: sortedRePages.length, total: pageTexts.length });

        const relevantPageBlock = sortedRePages
          .map(p => `=== SEITE ${p} ===\n${pageTexts[p - 1] ?? ''}`)
          .join('\n\n');
        const reContent = `${reExtractPrompt}\n\n${relevantPageBlock}`;

        const reResponse = await callWithRetry(() => createAnthropicMessage({
          model: config.UTILITY_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: 'user' as const, content: reContent }],
        }));
        const reText = reResponse.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text)
          .join('');

        const reJson = extractJsonFromText(reText);
        const reParsed = JSON.parse(reJson) as Record<string, { wert: unknown; quelle: string }>;

        let recovered = 0;
        for (const [path, value] of Object.entries(reParsed)) {
          if (!value?.wert || !value?.quelle) continue;
          // Navigate to the field — supports both dot notation and bracket notation
          // e.g. "forderungen.einzelforderungen[0].betrag"
          const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.');
          let obj: unknown = result;
          for (let i = 0; i < segments.length - 1; i++) {
            if (obj && typeof obj === 'object') {
              const key = segments[i];
              if (Array.isArray(obj)) {
                obj = obj[Number(key)];
              } else {
                obj = (obj as Record<string, unknown>)[key];
              }
            } else break;
          }
          if (obj && typeof obj === 'object') {
            const lastKey = segments[segments.length - 1];
            const container = Array.isArray(obj) ? obj[Number(lastKey)] : (obj as Record<string, unknown>)[lastKey];
            const field = container;
            if (field && typeof field === 'object' && 'wert' in (field as object)) {
              const f = field as { wert: unknown; quelle: string; verifiziert?: boolean };
              f.wert = value.wert;
              f.quelle = value.quelle;
              f.verifiziert = undefined;
              recovered++;
            }
          }
        }

        if (recovered > 0) {
          logger.info(`Targeted re-extraction recovered ${recovered}/${scalarRemovedPaths.length} fields`);
        }
      } catch (reErr) {
        logger.warn('Targeted re-extraction failed', { error: reErr instanceof Error ? reErr.message : String(reErr) });
      }
    }

    // Stage 3c: Focused handwriting extraction for Fragebogen pages
    // With native PDF: sends mini-PDF for vision-based handwriting OCR.
    // Without native PDF (Langdock): sends OCR text of form pages — still catches
    // structured form fields that the base extraction missed.
    if (pdfBuffer || pageTexts.length > 0) {
      report('Handschriftliche Formulare werden gelesen…', 85);
      try {
        result = await extractHandwrittenFormFields(result, pdfBuffer, pageTexts);
      } catch (err) {
        logger.warn('Handwriting extraction failed, continuing', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Stage 4: Enrichment Review — catch inference errors that pure extraction misses
    // Separates "what does the document literally say?" from "what does it mean?"
    // Targets specific known error patterns: address disambiguation, date selection, classification
    report('Plausibilitätsprüfung…', 88);
    try {
      result = await enrichmentReview(result, pageTexts);
    } catch (err) {
      logger.warn('Enrichment review failed, continuing without', { error: err instanceof Error ? err.message : String(err) });
    }

    report('Nachbearbeitung…', 89);
    result = postProcessDefaults(result);

    // Stage 5: Validation-driven retry — check critical fields, retry base extraction once if missing
    const criticalMissing: string[] = [];
    if (!result.verfahrensdaten?.aktenzeichen?.wert) criticalMissing.push('Aktenzeichen');
    if (!result.verfahrensdaten?.gericht?.wert) criticalMissing.push('Gericht');
    if (!result.schuldner?.name?.wert && !result.schuldner?.firma?.wert) criticalMissing.push('Name/Firma des Schuldners');
    if (!result.verfahrensdaten?.beschlussdatum?.wert && !result.verfahrensdaten?.antragsdatum?.wert) criticalMissing.push('Beschluss-/Antragsdatum');

    if (criticalMissing.length > 0) {
      report('Kritische Felder fehlen — Nachextraktion…', 90);
      logger.info('Validation-driven retry: kritische Felder fehlen', { missing: criticalMissing });
      try {
        const retryPrompt = `Bei der Extraktion dieser Insolvenzakte fehlen kritische Felder: ${criticalMissing.join(', ')}.

Prüfe die Akte NOCHMAL SORGFÄLTIG und extrahiere NUR diese fehlenden Felder.
Denke Schritt für Schritt:
1. Welche Dokumenttypen enthält die Akte? (Beschluss, Antrag, Anlage)
2. Wo stehen typischerweise ${criticalMissing.join(', ')}? (Rubrum, Beschluss, Antrag)
3. Suche gezielt auf den relevanten Seiten.

Antworte NUR mit validem JSON: {"feldpfad": {"wert": "...", "quelle": "Seite X, ..."}, ...}
Mögliche Felder: verfahrensdaten.aktenzeichen, verfahrensdaten.gericht, verfahrensdaten.beschlussdatum, verfahrensdaten.antragsdatum, schuldner.name, schuldner.vorname, schuldner.firma`;

        // Send first 30 pages (critical data is always at the start)
        const retryPages = pageTexts.slice(0, Math.min(30, pageTexts.length))
          .map((t, i) => `=== SEITE ${i + 1} ===\n${t}`).join('\n\n');

        const retryResponse = await callWithRetry(() => createAnthropicMessage({
          model: config.EXTRACTION_MODEL,
          max_tokens: 4096,
          temperature: 0,
          messages: [{ role: 'user' as const, content: `${retryPrompt}\n\n${retryPages}` }],
        }));

        const retryText = retryResponse.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text).join('');

        const retryJson = extractJsonFromText(retryText);
        const retryData = JSON.parse(retryJson) as Record<string, { wert: unknown; quelle: string }>;

        let recovered = 0;
        for (const [path, value] of Object.entries(retryData)) {
          if (!value?.wert || !value?.quelle) continue;
          const parts = path.split('.');
          let obj: Record<string, unknown> = result as unknown as Record<string, unknown>;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') break;
            obj = obj[parts[i]] as Record<string, unknown>;
          }
          const field = obj[parts[parts.length - 1]] as { wert: unknown; quelle: string } | undefined;
          if (field && (field.wert === null || field.wert === undefined || field.wert === '')) {
            field.wert = value.wert;
            field.quelle = value.quelle;
            recovered++;
          }
        }

        if (recovered > 0) {
          logger.info(`Validation-retry recovered ${recovered}/${criticalMissing.length} critical fields`);
          result = postProcessDefaults(result); // Re-run post-processing
        }
      } catch (retryErr) {
        logger.warn('Validation-driven retry failed', { error: retryErr instanceof Error ? retryErr.message : String(retryErr) });
      }
    }

    report('Standardanschreiben werden geprüft…', 91);
    result = validateLettersAgainstChecklists(result);

    const processingTimeMs = Date.now() - startTime;
    const stats = computeExtractionStats(result);

    db.prepare(
      `UPDATE extractions SET
        result_json = ?, status = 'completed',
        stats_found = ?, stats_missing = ?, stats_letters_ready = ?,
        processing_time_ms = ?
      WHERE id = ?`
    ).run(
      writeResultJson(result),
      stats.found, stats.missing, stats.lettersReady,
      processingTimeMs,
      extractionId
    );

    // Insert documents record for the main Gerichtsakte
    db.prepare(`
      INSERT OR IGNORE INTO documents (extraction_id, doc_index, source_type, original_filename, page_count)
      VALUES (?, 0, 'gerichtsakte', ?, ?)
    `).run(extractionId, filename, pageCount);

    logger.info('Extraktion abgeschlossen', {
      extractionId,
      found: stats.found,
      missing: stats.missing,
      lettersReady: stats.lettersReady,
      processingTimeMs,
    });

    deregisterExtraction();
    return { id: extractionId, result, stats, processingTimeMs };
  } catch (error) {
    deregisterExtraction();
    const processingTimeMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    db.prepare(
      `UPDATE extractions SET status = 'failed', error_message = ?, processing_time_ms = ? WHERE id = ?`
    ).run(errorMessage, processingTimeMs, extractionId);

    logger.error('Extraktion fehlgeschlagen', { extractionId, error: errorMessage });
    throw error;
  }
  } finally {
    // Restore original model after pro mode
    if (modelOverride) {
      (config as Record<string, unknown>).EXTRACTION_MODEL = originalModel;
    }
  }
}
