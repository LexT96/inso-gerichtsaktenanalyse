import path from 'path';
import { extractComprehensive, extractFromPageTexts, anthropic, callWithRetry, extractJsonFromText, EXTRACTION_PROMPT } from './anthropic';
import { extractWithOpenAI } from './openaiExtractor';
import { detectProvider, supportsNativePdf, isRateLimited, logProviderConfig } from './extractionProvider';
import { computeExtractionStats } from '../utils/computeStats';
import { config } from '../config';
import { extractTextPerPage } from './pdfProcessor';
import { getDb } from '../db/database';
import { writeResultJson } from '../db/resultJson';
import { logger } from '../utils/logger';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { analyzeDocumentStructure, classifySegmentsForExtraction } from '../utils/documentAnalyzer';
import type { DocumentAnalysis } from '../utils/documentAnalyzer';
import { extractForderungen } from '../utils/forderungenExtractor';
import { semanticVerify } from '../utils/semanticVerifier';
import { extractAktiva } from '../utils/aktivaExtractor';
import { analyzeAnfechtung } from '../utils/anfechtungsAnalyzer';
import { enrichmentReview } from '../utils/enrichmentReview';
import { PDFDocument } from 'pdf-lib';
import type { ExtractionResult } from '../types/extraction';

const isRateLimitedProvider = (): boolean => isRateLimited(detectProvider());

const LARGE_PDF_THRESHOLD = 500; // pages — above this, use chunked fallback
// For rate-limited providers, force chunked mode for any PDF
const effectiveThreshold = (): number => isRateLimitedProvider() ? 0 : LARGE_PDF_THRESHOLD;

import type { ExtractionStats } from '../utils/computeStats';

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
  pdfBuffer: Buffer,
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
  });

  // Extract only the form pages as a mini-PDF
  const miniPdf = await extractPdfPages(pdfBuffer, formPages);
  const base64 = miniPdf.toString('base64');

  // Map page indices to actual page numbers for the prompt
  const pageMapping = formPages.map((p, i) => `PDF-Seite ${i + 1} = Originalseite ${p + 1}`).join(', ');

  // Use Sonnet for handwriting OCR — Haiku lacks vision quality for handwritten forms
  // But limit max_tokens since output is a small JSON object (~20 fields)
  const handwritingModel = config.EXTRACTION_MODEL;
  const response = await callWithRetry(() => anthropic.messages.create({
    model: handwritingModel,
    max_tokens: 4096,
    temperature: 0,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
        { type: 'text' as const, text: `${HANDWRITING_PROMPT}\n\nSeitenzuordnung: ${pageMapping}\nBitte verwende die Originalseitennummern in der quelle.` },
      ],
    }],
  }));

  const text = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');

  let parsed: Record<string, { wert: unknown; quelle: string }>;
  try {
    const jsonStr = extractJsonFromText(text);
    parsed = JSON.parse(jsonStr);
  } catch {
    logger.warn('Handwriting extraction JSON parse failed', { sample: text.slice(0, 300) });
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
  const report = onProgress ?? (() => {});
  const db = getDb();
  const startTime = Date.now();

  // Create extraction record
  const insertResult = db.prepare(
    'INSERT INTO extractions (user_id, filename, file_size, status) VALUES (?, ?, ?, ?)'
  ).run(userId, filename, fileSize, 'processing');
  const extractionId = Number(insertResult.lastInsertRowid);

  try {
    // Save PDF to disk for later viewing (stored alongside DB in /data volume)
    const pdfDir = path.resolve(path.dirname(config.DATABASE_PATH || './data/insolvenz.db'), 'pdfs');
    const fs = await import('fs');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(path.join(pdfDir, `${extractionId}.pdf`), pdfBuffer);
    logger.info('PDF gespeichert', { extractionId, path: path.join(pdfDir, `${extractionId}.pdf`) });

    report('Seitentext wird extrahiert…', 8);

    // Always extract text per page — needed for analysis and verification
    const pageTexts = await extractTextPerPage(pdfBuffer);
    const pageCount = pageTexts.length;
    logger.info('PDF Seitenanzahl ermittelt', { pageCount });

    report(`${pageCount} Seiten erkannt — Dokumentstruktur wird analysiert… (Stufe 1/3)`, 15);

    // Stage 1: Analyze document structure → text map + parsed segments
    const { mapText: documentMap, segments } = await analyzeDocumentStructure(pageTexts);

    report('Daten werden extrahiert… (Stufe 2/3)', 30);

    // Stage 2: Extract data — single comprehensive call for normal PDFs,
    // chunked fallback with separate aktiva/anfechtung for very large PDFs
    let result: ExtractionResult;

    const provider = detectProvider();
    logProviderConfig();

    if (provider === 'openai') {
      // OpenAI/GPT extraction — vision via images, auto-chunks for large files
      report(`GPT-Extraktion (${pageCount} S.)… (Stufe 2/3)`, 35);
      result = await extractWithOpenAI(pdfBuffer, pageTexts, EXTRACTION_PROMPT, documentMap, segments);
    } else if (pageCount <= effectiveThreshold()) {
      // Multi-pass extraction: base (Sonnet) + focused passes (Haiku) in parallel
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
        const forderungenResult = await extractForderungen(pageTexts, routing.forderungenPages, documentMap)
          .catch(err => { logger.warn('Forderungen-Extraktion fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });
        await new Promise(r => setTimeout(r, 62_000));
        const aktivaResult = await extractAktiva(pageTexts, documentMap, result)
          .catch(err => { logger.warn('Aktiva-Extraktion fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });
        await new Promise(r => setTimeout(r, 62_000));
        const anfechtungResult = await analyzeAnfechtung(pageTexts, documentMap, result)
          .catch(err => { logger.warn('Anfechtungsanalyse fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) }); return null; });

        if (forderungenResult) result.forderungen = forderungenResult;
        if (aktivaResult) result.aktiva = aktivaResult;
        if (anfechtungResult) result.anfechtung = anfechtungResult;
      } else {
        // Normal: run all three in parallel
        const [forderungenResult, aktivaResult, anfechtungResult] = await Promise.allSettled([
          extractForderungen(pageTexts, routing.forderungenPages, documentMap),
          extractAktiva(pageTexts, documentMap, result),
          analyzeAnfechtung(pageTexts, documentMap, result),
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
      logger.info(`Großes PDF (${pageCount} S.) — verwende ${chunkInfo}`);
      report(`Großes PDF (${pageCount} S.) — Parallele Extraktion… (Stufe 2/3)`, 35);
      result = await extractFromPageTexts(pageTexts, documentMap, segments);

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
        aktivaResult = await extractAktiva(pageTexts, documentMap, result)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
        await new Promise(r => setTimeout(r, 62_000));
        report('Anfechtungsanalyse…', 60);
        anfechtungResult = await analyzeAnfechtung(pageTexts, documentMap, result)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
        await new Promise(r => setTimeout(r, 62_000));
        report('Forderungen-Analyse…', 62);
        forderungenChunkedResult = await extractForderungen(pageTexts, chunkedRouting.forderungenPages, documentMap)
          .then(v => ({ status: 'fulfilled' as const, value: v }))
          .catch(reason => ({ status: 'rejected' as const, reason }));
      } else {
        [aktivaResult, anfechtungResult, forderungenChunkedResult] = await Promise.allSettled([
          extractAktiva(pageTexts, documentMap, result),
          analyzeAnfechtung(pageTexts, documentMap, result),
          extractForderungen(pageTexts, chunkedRouting.forderungenPages, documentMap),
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

    // Stage 3b: Targeted re-extraction for fields removed by verifier
    // Research shows guided re-extraction recovers 5-15% of lost fields
    if (verifyResult.removedPaths.length > 0 && verifyResult.removedPaths.length <= 20) {
      report('Fehlende Felder werden nachextrahiert…', 82);
      logger.info('Targeted re-extraction', { removedPaths: verifyResult.removedPaths });
      try {
        const reExtractPrompt = `Du bist ein Extraktionsassistent. Die folgenden Felder wurden bei der vorherigen Extraktion als fehlerhaft erkannt und entfernt. Prüfe die Akte erneut SORGFÄLTIG und extrahiere NUR diese spezifischen Felder. Antworte mit einem JSON-Objekt das NUR die gefundenen Felder enthält (Pfad als Key, {wert, quelle} als Value). Wenn ein Feld wirklich nicht in der Akte steht, lasse es weg.

Gesuchte Felder: ${verifyResult.removedPaths.join(', ')}

Antworte NUR mit validem JSON: {"feldpfad": {"wert": "...", "quelle": "Seite X, ..."}, ...}`;

        const relevantPages = pageTexts.map((t, i) => `=== SEITE ${i + 1} ===\n${t}`).join('\n\n');
        const reContent = `${reExtractPrompt}\n\n${relevantPages}`;

        const reResponse = await callWithRetry(() => anthropic.messages.create({
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
          logger.info(`Targeted re-extraction recovered ${recovered}/${verifyResult.removedPaths.length} fields`);
        }
      } catch (reErr) {
        logger.warn('Targeted re-extraction failed', { error: reErr instanceof Error ? reErr.message : String(reErr) });
      }
    }

    // Stage 3c: Focused handwriting extraction for Fragebogen pages
    // Claude's vision CAN read handwriting but misses details when processing 30+ pages at once.
    // This pass sends ONLY the form pages with a focused prompt → dramatically better results.
    if (supportsNativePdf(provider) && pdfBuffer) {
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

    report('Standardanschreiben werden geprüft…', 90);
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

    logger.info('Extraktion abgeschlossen', {
      extractionId,
      found: stats.found,
      missing: stats.missing,
      lettersReady: stats.lettersReady,
      processingTimeMs,
    });

    return { id: extractionId, result, stats, processingTimeMs };
  } catch (error) {
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
