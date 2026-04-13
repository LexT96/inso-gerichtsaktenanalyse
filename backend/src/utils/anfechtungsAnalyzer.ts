/**
 * Anfechtungsanalyse — Stage 2c of the pipeline.
 *
 * Separate Claude API call to identify potentially contestable transactions
 * (anfechtbare Rechtshandlungen) under §§ 129-147 InsO. Runs after Aktiva
 * extraction (Stage 2b) and before semantic verification (Stage 3).
 *
 * Graceful degradation: returns null on any failure so the pipeline
 * continues without Anfechtung data.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { callWithRetry, extractJsonFromText, createAnthropicMessage } from '../services/anthropic';
import { buildEnrichedPageBlock } from './ocrEnricher';
import { renderPagesToJpeg } from './pageImageRenderer';
import type { OcrResult } from '../services/ocrService';
import { config } from '../config';
import { logger } from './logger';
import type { Anfechtungsanalyse, ExtractionResult } from '../types/extraction';

// ─── Zod schema for validation ───

const sourcedValueSchema = z.object({
  wert: z.preprocess(
    (v) => (v === undefined ? null : v),
    z.union([z.string(), z.null()])
  ),
  quelle: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string()
  ),
});

const sourcedNumberSchema = z.object({
  wert: z.preprocess(
    (v) => {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        // German number format: 1.234,56 → 1234.56
        const cleaned = v.replace(/\./g, '').replace(',', '.');
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
      }
      return null;
    },
    z.number().nullable()
  ),
  quelle: z.preprocess(
    (v) => (typeof v === 'string' ? v : ''),
    z.string()
  ),
});

const ANFECHTUNGS_GRUNDLAGE_VALUES = [
  '§130 Kongruente Deckung', '§131 Inkongruente Deckung',
  '§132 Unmittelbar nachteilige Rechtshandlung', '§133 Vorsätzliche Benachteiligung',
  '§134 Unentgeltliche Leistung', '§135 Gesellschafterdarlehen', '§142 Bargeschäft',
] as const;

const anfechtungsGrundlageSchema = z.preprocess(
  (v) => {
    const s = String(v ?? '').trim();
    for (const g of ANFECHTUNGS_GRUNDLAGE_VALUES) {
      if (s.includes(g) || s.toLowerCase().includes(g.split(' ').slice(1).join(' ').toLowerCase())) return g;
    }
    if (s.includes('130') || s.toLowerCase().includes('kongruent')) return '§130 Kongruente Deckung';
    if (s.includes('131') || s.toLowerCase().includes('inkongruent')) return '§131 Inkongruente Deckung';
    if (s.includes('132') || s.toLowerCase().includes('unmittelbar')) return '§132 Unmittelbar nachteilige Rechtshandlung';
    if (s.includes('133') || s.toLowerCase().includes('vorsätzlich') || s.toLowerCase().includes('vorsaetzlich')) return '§133 Vorsätzliche Benachteiligung';
    if (s.includes('134') || s.toLowerCase().includes('unentgeltlich')) return '§134 Unentgeltliche Leistung';
    if (s.includes('135') || s.toLowerCase().includes('gesellschafter')) return '§135 Gesellschafterdarlehen';
    if (s.includes('142') || s.toLowerCase().includes('bargeschäft') || s.toLowerCase().includes('bargeschaeft')) return '§142 Bargeschäft';
    return '§130 Kongruente Deckung';
  },
  z.enum(ANFECHTUNGS_GRUNDLAGE_VALUES)
);

const anfechtbarerVorgangSchema = z.object({
  beschreibung: sourcedValueSchema,
  betrag: sourcedNumberSchema,
  datum: sourcedValueSchema,
  empfaenger: sourcedValueSchema,
  grundlage: anfechtungsGrundlageSchema,
  risiko: z.preprocess(
    (v) => {
      const s = String(v ?? 'gering').toLowerCase();
      return s.includes('hoch') ? 'hoch' : s.includes('mittel') ? 'mittel' : 'gering';
    },
    z.enum(['hoch', 'mittel', 'gering'])
  ),
  begruendung: z.preprocess((v) => String(v ?? ''), z.string()),
  anfechtbar_ab: z.preprocess((v) => String(v ?? ''), z.string()),
  ist_nahestehend: z.preprocess(
    (v) => v === true || v === 'true' || v === 'ja',
    z.boolean()
  ),
});

const anfechtungsanalyseSchema = z.object({
  vorgaenge: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(anfechtbarerVorgangSchema)
  ),
  gesamtpotenzial: sourcedNumberSchema,
  zusammenfassung: z.preprocess((v) => String(v ?? ''), z.string()),
});

// ─── Prompt ───

const ANFECHTUNG_PROMPT = `Du bist ein spezialisierter KI-Assistent für Insolvenzanfechtung nach §§ 129-147 InsO.
Analysiere die Gerichtsakte und identifiziere ALLE potenziell anfechtbaren Rechtshandlungen.

Anfechtungsgründe:
- § 130 Kongruente Deckung: Zahlungen auf fällige Forderungen in den letzten 3 Monaten vor Antrag, wenn Gläubiger Kenntnis von Zahlungsunfähigkeit hatte
- § 131 Inkongruente Deckung: Sicherungen/Befriedigungen die der Gläubiger nicht beanspruchen konnte, in den letzten 3 Monaten vor Antrag (Nr. 1: letzter Monat bedingungslos, Nr. 2-3: 2.+3. Monat bei Kenntnis der Zahlungsunfähigkeit)
- § 132 Unmittelbar nachteilige Rechtshandlung: Rechtsgeschäfte mit Dritten die Gläubiger unmittelbar benachteiligen
- § 133 Vorsätzliche Benachteiligung: Handlungen mit Benachteiligungsvorsatz (10 Jahre, bei Nahestehenden vermutet)
- § 134 Unentgeltliche Leistung: Schenkungen und unentgeltliche Zuwendungen (4 Jahre)
- § 135 Gesellschafterdarlehen: Rückzahlung von Gesellschafterdarlehen (1 Jahr)
- § 142 Bargeschäft: Leistung und Gegenleistung zeitnah ausgetauscht (privilegiert, Ausnahme)

Für § 138 InsO Nahestehende:
- Ehegatten, Lebenspartner, Verwandte in gerader Linie
- Gesellschafter mit >25% Anteil, Geschäftsführer
- Personen in persönlicher Verbundenheit

Bewerte jede identifizierte Handlung mit:
- risiko: "hoch" (klare Anfechtbarkeit), "mittel" (abhängig von Beweislage), "gering" (fraglich, aber prüfenswert)

PFLICHT: Jedes Feld mit ausgefülltem "wert" MUSS eine "quelle" haben. Format: "Seite X, [Dokument/Abschnitt]". Die quelle muss die tatsächliche Fundstelle sein — die Seite, auf der du den Wert im vorliegenden Dokument gefunden hast.
Datumsformat: TT.MM.JJJJ. Beträge: deutsche Schreibweise mit Komma (1.234,56) oder Zahl.

Suche insbesondere nach:
1. Zahlungen vor Antragstellung — insbesondere an Sozialversicherungsträger, Finanzamt, Vermieter
2. Sicherheitenbestellungen in der Krise — nachträgliche Grundschulden, Sicherungsübereignungen, Abtretungen
3. Unentgeltliche Leistungen — Schenkungen, Vermögensübertragungen ohne Gegenleistung
4. Nahestehende Personen (§ 138 InsO) — Zahlungen/Übertragungen an Ehegatten, Verwandte, verbundene Unternehmen

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks). In allen String-Werten Anführungszeichen mit \\ escapen, keine Zeilenumbrüche innerhalb von Strings.

{
  "vorgaenge": [
    {
      "beschreibung": {"wert": "Beschreibung der anfechtbaren Handlung", "quelle": "Seite X, Abschnitt"},
      "betrag": {"wert": 0, "quelle": "Seite X, Abschnitt"},
      "datum": {"wert": "TT.MM.JJJJ", "quelle": "Seite X, Abschnitt"},
      "empfaenger": {"wert": "Name des Empfängers", "quelle": "Seite X, Abschnitt"},
      "grundlage": "§130 Kongruente Deckung",
      "risiko": "hoch",
      "begruendung": "Ausführliche rechtliche Begründung der Anfechtbarkeit",
      "anfechtbar_ab": "TT.MM.JJJJ",
      "ist_nahestehend": false
    }
  ],
  "gesamtpotenzial": {"wert": null, "quelle": ""},
  "zusammenfassung": "Zusammenfassende Bewertung des Anfechtungspotenzials"
}

REGELN:
- Nur extrahieren, was tatsächlich im Dokument steht oder sich aus den Daten ableiten lässt.
- Wenn keine anfechtbaren Vorgänge erkennbar sind, leere vorgaenge-Liste zurückgeben.
- gesamtpotenzial: Auf null setzen — wird automatisch vom System aus den Einzelbeträgen berechnet. NIEMALS selbst addieren.
- anfechtbar_ab: Auf null setzen — die Berechnung der Anfechtungsfrist erfolgt automatisch im System.
- ist_nahestehend: true wenn der Empfänger eine nahestehende Person i.S.v. § 138 InsO ist.
- ERINNERUNG: Jeder nicht-leere wert braucht eine quelle (Seite X, ...). Keine Ausnahme.

Wenn eine DOKUMENTSTRUKTUR mitgegeben wird, nutze sie NUR um zu verstehen welcher Dokumentteil was enthält. Die SEITENZAHLEN in der quelle müssen von der EXAKTEN Seite kommen, auf der du den Wert im Akteninhalt findest — NICHT aus der Dokumentstruktur-Übersicht.`;

// ─── Deadline calculation ───

/**
 * Calculate the Anfechtungsfrist (deadline) based on the Antragsdatum and the legal basis.
 * Returns a date string in DD.MM.YYYY format, or empty string if Antragsdatum is unavailable.
 */
function calculateFrist(antragsdatum: string | null | undefined, grundlage: string): string {
  if (!antragsdatum) return '';

  // Parse German date format DD.MM.YYYY
  const parts = antragsdatum.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!parts) return '';

  const date = new Date(parseInt(parts[3]), parseInt(parts[2]) - 1, parseInt(parts[1]));
  if (isNaN(date.getTime())) return '';

  // Calculate lookback period based on legal basis
  if (grundlage.includes('§133')) {
    // § 133: 10 years before filing
    date.setFullYear(date.getFullYear() - 10);
  } else if (grundlage.includes('§134')) {
    // § 134: 4 years before filing
    date.setFullYear(date.getFullYear() - 4);
  } else if (grundlage.includes('§135')) {
    // § 135: 1 year before filing
    date.setFullYear(date.getFullYear() - 1);
  } else {
    // § 130, § 131, § 132, § 142: 3 months before filing
    date.setMonth(date.getMonth() - 3);
  }

  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

// ─── Hints from existing extraction ───

function buildHints(existingResult: Partial<ExtractionResult>): string {
  const hints: string[] = [];

  const antragsdatum = existingResult?.verfahrensdaten?.antragsdatum?.wert;
  if (antragsdatum) {
    hints.push(`- Antragsdatum: ${antragsdatum}`);
    hints.push(`- Anfechtungsfristen: §130/131 = 3 Monate vor Antrag, §133 = 10 Jahre, §134 = 4 Jahre, §135 = 1 Jahr`);
  }

  const forderungen = existingResult?.forderungen;
  if (forderungen?.einzelforderungen?.length) {
    const glaeubigerList = forderungen.einzelforderungen
      .filter(ef => ef.glaeubiger?.wert)
      .map(ef => `${ef.glaeubiger.wert} (${ef.betrag?.wert ? ef.betrag.wert.toLocaleString('de-DE') + ' EUR' : 'Betrag unbekannt'})`)
      .slice(0, 10);
    if (glaeubigerList.length > 0) {
      hints.push(`- Bekannte Gläubiger: ${glaeubigerList.join(', ')}`);
    }
  }

  const schuldner = existingResult?.schuldner;
  if (schuldner?.familienstand?.wert) {
    hints.push(`- Familienstand: ${schuldner.familienstand.wert} (relevant für § 138 InsO Nahestehende)`);
  }
  if (schuldner?.firma?.wert) {
    hints.push(`- Firma: ${schuldner.firma.wert} (prüfe Gesellschafterdarlehen § 135 InsO)`);
  }

  return hints.length > 0
    ? `\n--- HINWEISE AUS BISHERIGER ANALYSE ---\n${hints.join('\n')}\n--- ENDE HINWEISE ---\n`
    : '';
}

// ─── Main ───

export async function analyzeAnfechtung(
  pageTexts: string[],
  documentMap: string | undefined,
  existingResult: Partial<ExtractionResult>,
  relevantPages?: number[],
  ocrResult?: OcrResult | null,
  pdfBuffer?: Buffer | null,
): Promise<Anfechtungsanalyse | null> {
  try {
    // Use all pages by default. Only use routed subset if all pages exceed token limit.
    const MAX_CHARS = 450_000; // ~180K tokens at 2.5 chars/tok, under 200K API limit
    let pages = pageTexts.map((_, i) => i + 1);
    const totalChars = pageTexts.reduce((sum, t) => sum + t.length, 0);

    if (totalChars > MAX_CHARS) {
      if (relevantPages && relevantPages.length < pages.length) {
        pages = relevantPages;
      }
      let charSum = 0;
      const fittingPages: number[] = [];
      for (const p of pages) {
        charSum += (pageTexts[p - 1] ?? '').length + 20;
        if (charSum > MAX_CHARS) break;
        fittingPages.push(p);
      }
      if (fittingPages.length < pages.length) {
        pages = fittingPages;
      }
      logger.info('Anfechtungsanalyse: Token-Budget-Guard', {
        totalChars, maxChars: MAX_CHARS, allPages: pageTexts.length, usingPages: pages.length,
      });
    }
    logger.info('Anfechtungsanalyse gestartet', { totalPages: pageTexts.length, usingPages: pages.length });

    const mapBlock = documentMap
      ? `\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
      : '';

    const hintsBlock = buildHints(existingResult);

    const pageBlock = ocrResult
      ? buildEnrichedPageBlock(ocrResult, pages, pageTexts)
      : pages.map((pageNum) => `=== SEITE ${pageNum} ===\n${pageTexts[pageNum - 1] ?? ''}`).join('\n\n');

    const dynamicContent = `${mapBlock}${hintsBlock}\n--- AKTENINHALT (${pages.length} Seiten) ---\n\n${pageBlock}`;
    const textContent = dynamicContent;

    // Build content blocks: text + page images (if PDF available, max 20 images)
    let messageContent: string | Array<{ type: string; [key: string]: unknown }> = textContent;
    if (pdfBuffer && pages.length <= 30) {
      const pageImages = renderPagesToJpeg(pdfBuffer, pages.map(p => p - 1)); // 0-indexed
      if (pageImages.size > 0) {
        const blocks: Array<{ type: string; [key: string]: unknown }> = [];
        blocks.push({ type: 'text', text: textContent });
        blocks.push({ type: 'text', text: '\n--- BILDANSICHT (für Handschrift, Tabellen, Stempel) ---' });
        for (const pageNum of pages) {
          const b64 = pageImages.get(pageNum - 1);
          if (b64) {
            blocks.push({ type: 'text', text: `=== BILD SEITE ${pageNum} ===` });
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
          }
        }
        messageContent = blocks;
        logger.info('Anfechtungsanalyse: Bild+Text-Modus', { images: pageImages.size, textPages: pages.length });
      }
    }

    const model = config.UTILITY_MODEL || 'claude-haiku-4-5-20251001';

    const response = await callWithRetry(() =>
      createAnthropicMessage({
        model,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [{ role: 'user' as const, content: messageContent as any }],
      }, ANFECHTUNG_PROMPT)
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    // Parse JSON response
    const jsonStr = extractJsonFromText(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      try {
        const repaired = jsonrepair(jsonStr);
        parsed = JSON.parse(repaired);
        logger.info('Anfechtungs-JSON per jsonrepair repariert');
      } catch (repairErr) {
        logger.error('Anfechtungs-JSON konnte nicht geparst werden', {
          error: repairErr instanceof Error ? repairErr.message : String(repairErr),
          sample: jsonStr.slice(0, 300),
        });
        return null;
      }
    }

    // Validate with Zod schema
    const result = anfechtungsanalyseSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 5);
      logger.warn('Anfechtungs-Schema-Validierung: Abweichungen', {
        issueCount: result.error.issues.length,
        paths: issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
      // Try to use parsed data directly as fallback
      return (parsed ?? null) as Anfechtungsanalyse | null;
    }

    const anfechtung = result.data as unknown as Anfechtungsanalyse;

    // Post-process: calculate anfechtbar_ab for vorgaenge where it's missing
    const antragsdatum = existingResult?.verfahrensdaten?.antragsdatum?.wert;
    for (const vorgang of anfechtung.vorgaenge) {
      if (!vorgang.anfechtbar_ab && antragsdatum) {
        vorgang.anfechtbar_ab = calculateFrist(antragsdatum, vorgang.grundlage);
      }
    }

    logger.info('Anfechtungsanalyse abgeschlossen', {
      vorgaenge: anfechtung.vorgaenge.length,
      gesamtpotenzial: anfechtung.gesamtpotenzial?.wert ?? null,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    return anfechtung;
  } catch (err) {
    logger.error('Anfechtungsanalyse fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
