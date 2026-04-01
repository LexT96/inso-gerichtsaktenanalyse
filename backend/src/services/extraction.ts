import path from 'path';
import { extractComprehensive, extractFromPageTexts, anthropic, callWithRetry, extractJsonFromText } from './anthropic';
import { config } from '../config';
import { extractTextPerPage } from './pdfProcessor';
import { getDb } from '../db/database';
import { writeResultJson } from '../db/resultJson';
import { logger } from '../utils/logger';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import { analyzeDocumentStructure } from '../utils/documentAnalyzer';
import type { DocumentAnalysis } from '../utils/documentAnalyzer';
import { semanticVerify } from '../utils/semanticVerifier';
import { extractAktiva } from '../utils/aktivaExtractor';
import { analyzeAnfechtung } from '../utils/anfechtungsAnalyzer';
import { enrichmentReview } from '../utils/enrichmentReview';
import { PDFDocument } from 'pdf-lib';
import type { ExtractionResult } from '../types/extraction';

// Rate-limited providers (Langdock: 60K TPM) must always use chunked mode
const isRateLimitedProvider = (): boolean =>
  Boolean(config.ANTHROPIC_BASE_URL?.includes('langdock'));

const LARGE_PDF_THRESHOLD = 500; // pages — above this, use chunked fallback
// For rate-limited providers, force chunked mode for any PDF
const effectiveThreshold = (): number => isRateLimitedProvider() ? 0 : LARGE_PDF_THRESHOLD;

interface ExtractionStats {
  found: number;
  missing: number;
  lettersReady: number;
}

function isEmpty(field: { wert?: unknown; quelle?: unknown } | null | undefined): boolean {
  if (!field) return true;
  const w = field.wert;
  return w === null || w === undefined || w === '';
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

  // 6. Compute summe_aktiva if null but positions exist
  if (result.aktiva?.positionen?.length && result.aktiva.summe_aktiva?.wert == null) {
    const total = result.aktiva.positionen.reduce((sum, p) => {
      const w = p.geschaetzter_wert?.wert;
      return sum + (typeof w === 'number' ? w : 0);
    }, 0);
    if (total > 0) {
      result.aktiva.summe_aktiva = { wert: total, quelle: 'Berechnet aus Einzelpositionen' };
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

function computeStats(result: ExtractionResult): ExtractionStats {
  let found = 0;
  let missing = 0;
  const isEntity = isJuristischePersonResult(result);

  const walkObj = (obj: Record<string, unknown>, parentKey?: string): void => {
    if (!obj) return;
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) continue;
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if ('wert' in v || 'quelle' in v) {
          // Skip entity-irrelevant fields
          if (!isEntity && ENTITY_ONLY_FIELDS.has(key)) continue;
          if (isEntity && PERSON_ONLY_FIELDS.has(key)) continue;
          // Skip optional fields that shouldn't count as missing
          if (OPTIONAL_STATS_FIELDS.has(key) && isEmpty(v as { wert?: unknown })) continue;

          isEmpty(v as { wert?: unknown; quelle?: unknown }) ? missing++ : found++;
        } else {
          walkObj(v as Record<string, unknown>, key);
        }
      }
    }
  };

  walkObj(result.verfahrensdaten as unknown as Record<string, unknown>);
  walkObj(result.schuldner as unknown as Record<string, unknown>);
  walkObj(result.antragsteller as unknown as Record<string, unknown>);
  walkObj(result.forderungen as unknown as Record<string, unknown>);
  // Also walk each einzelforderung (walkObj skips arrays by default)
  if (result.forderungen?.einzelforderungen) {
    for (const ef of result.forderungen.einzelforderungen) {
      walkObj(ef as unknown as Record<string, unknown>);
    }
  }
  walkObj(result.gutachterbestellung as unknown as Record<string, unknown>);

  const lettersReady = (result.standardanschreiben || [])
    .filter(l => l.status === 'bereit').length;

  return { found, missing, lettersReady };
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

    if (pageCount <= effectiveThreshold()) {
      // Single comprehensive call — extracts base data + aktiva + anfechtung
      report(`Vollständige Analyse (${pageCount} S.)… (Stufe 2/3)`, 35);
      result = await extractComprehensive(pdfBuffer, pageTexts, documentMap);
    } else {
      // Fallback: chunked extraction for very large PDFs
      const chunkInfo = segments.length > 0
        ? `dokumentbasiertes Chunking (${segments.length} Segmente)`
        : 'seitenbasiertes Chunking';
      logger.info(`Großes PDF (${pageCount} S.) — verwende ${chunkInfo}`);
      report(`Großes PDF (${pageCount} S.) — Parallele Extraktion… (Stufe 2/3)`, 35);
      result = await extractFromPageTexts(pageTexts, documentMap, segments);

      // For chunked extraction, run aktiva + anfechtung separately
      // On rate-limited providers, serialize with delay
      report('Zusatzanalysen…', 55);
      let aktivaResult: PromiseSettledResult<Awaited<ReturnType<typeof extractAktiva>>>;
      let anfechtungResult: PromiseSettledResult<Awaited<ReturnType<typeof analyzeAnfechtung>>>;

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
      } else {
        [aktivaResult, anfechtungResult] = await Promise.allSettled([
          extractAktiva(pageTexts, documentMap, result),
          analyzeAnfechtung(pageTexts, documentMap, result),
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
    }

    report('Quellenangaben werden verifiziert… (Stufe 3/3)', 65);

    // Stage 3: Verify and correct against actual page texts + document structure
    const verifyResult = await semanticVerify(result, pageTexts, documentMap);
    result = verifyResult.result;

    // Stage 3b: Targeted re-extraction for fields removed by verifier
    // Research shows guided re-extraction recovers 5-15% of lost fields
    if (verifyResult.removedPaths.length > 0 && verifyResult.removedPaths.length <= 10) {
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
          // Navigate to the field and set it
          const parts = path.split('.');
          let obj: unknown = result;
          for (let i = 0; i < parts.length - 1; i++) {
            if (obj && typeof obj === 'object') obj = (obj as Record<string, unknown>)[parts[i]];
            else break;
          }
          if (obj && typeof obj === 'object') {
            const lastKey = parts[parts.length - 1];
            const field = (obj as Record<string, unknown>)[lastKey];
            if (field && typeof field === 'object' && 'wert' in (field as object)) {
              const f = field as { wert: unknown; quelle: string; verifiziert?: boolean };
              f.wert = value.wert;
              f.quelle = value.quelle;
              f.verifiziert = undefined; // Needs re-verification
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
    const supportsNativePdf = !config.ANTHROPIC_BASE_URL;
    if (supportsNativePdf && pdfBuffer) {
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
    const stats = computeStats(result);

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
