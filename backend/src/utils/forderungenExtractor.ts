/**
 * Forderungen/Creditor extraction — focused Haiku pass.
 *
 * Extracts einzelforderungen (creditor claims) and betroffene_arbeitnehmer
 * from creditor-relevant pages. Runs in parallel with aktiva/anfechtung.
 *
 * Graceful degradation: returns null on any failure so the pipeline
 * continues without forderungen data (base extraction may still have partial data).
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
import type { Forderungen } from '../types/extraction';

// ─── Zod schemas ───

const sourcedValueSchema = z.object({
  wert: z.preprocess(
    (v) => (v === undefined ? null : v),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
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

const einzelforderungSchema = z.object({
  glaeubiger: sourcedValueSchema,
  art: z.preprocess((v) => String(v ?? 'sonstige'), z.string()),
  rang: z.preprocess((v) => String(v ?? '§38 Insolvenzforderung'), z.string()),
  betrag: sourcedNumberSchema,
  zeitraum_von: sourcedValueSchema.optional(),
  zeitraum_bis: sourcedValueSchema.optional(),
  titel: sourcedValueSchema,
  sicherheit: z.any().optional(),
  ist_antragsteller: z.preprocess((v) => v === true || v === 'true', z.boolean()).optional(),
});

const forderungenSchema = z.object({
  einzelforderungen: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(einzelforderungSchema)
  ),
  gesamtforderungen: sourcedNumberSchema.optional(),
  gesicherte_forderungen: sourcedNumberSchema.optional(),
  ungesicherte_forderungen: sourcedNumberSchema.optional(),
  betroffene_arbeitnehmer: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(z.any())
  ).optional(),
});

// ─── Prompt ───

const FORDERUNGEN_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter. Extrahiere ALLE Forderungen/Verbindlichkeiten aus den folgenden Seiten.

PFLICHT: Jedes Feld mit ausgefülltem "wert" MUSS eine "quelle" haben. Format: "Seite X, [Dokument/Abschnitt]".
Datumsformat: TT.MM.JJJJ. Beträge: IMMER als reine Zahl ohne Tausendertrennzeichen (z.B. 100000.00 NICHT 100.000,00).

ABSOLUTES VERBOT — Beträge NIEMALS selbst berechnen: Wenn eine Forderung aus Teilbeträgen besteht (z.B. Nennbetrag + Zinsen bei Wandeldarlehen, oder Hauptforderung + Nebenforderungen), setze betrag auf NULL. Trage die Komponenten NUR in das titel-Feld ein, z.B. "Wandeldarlehen: Nennbetrag 50.000,00 EUR; Zinsen 1.791,67 EUR". Die Berechnung der Summe erfolgt automatisch im System. Setze betrag NUR dann, wenn ein einzelner EXPLIZITER Gesamtbetrag im Dokument steht.

WICHTIG — glaeubiger ist IMMER ein Name: Das Feld glaeubiger.wert MUSS der Name einer Person, Firma oder Organisation sein. NIEMALS Beträge, Seitenreferenzen oder Datumsangaben als Gläubigernamen eintragen.

WICHTIG — VOLLSTÄNDIGKEIT: Extrahiere JEDEN einzelnen Gläubiger/Forderung. Bei langen Tabellen (z.B. 15+ Wandeldarlehen) MÜSSEN ALLE Einträge extrahiert werden — auch die letzten. Zähle die Einträge in der Tabelle und vergleiche mit deiner Ausgabe.

WICHTIG — TEUR-Tabellen EXAKT lesen: Wenn eine Tabelle Positionen in TEUR auflistet (z.B. "Lohnsteuerverbindlichkeiten 29, Umsatzsteuer 11, Kreditkarten 10, Sozialversicherungsträger 5"), ordne JEDEN Betrag EXAKT der Zeile zu, in der er steht. NICHT die Zeilen durcheinanderbringen. Lies die Tabelle Zeile für Zeile von oben nach unten. Trage den Betrag im titel-Feld als "TEUR X" ein — die Umrechnung in EUR erfolgt automatisch. Wenn der Gläubigername generisch ist (z.B. "Kreditkarten", "Sonstige"), verwende genau diese Bezeichnung als glaeubiger.

Für jeden Gläubiger erstelle ein einzelnes Objekt:
- glaeubiger: Name der Person/Firma/Organisation
- art: "sozialversicherung"|"steuer"|"bank"|"lieferant"|"arbeitnehmer"|"miete"|"sonstige"
- rang: "§38 Insolvenzforderung"|"§39 Nachrangig"|"Masseforderung §55"
- betrag: Nur expliziter Gesamtbetrag aus dem Dokument, sonst null
- titel: Beschreibung inkl. Aufschlüsselung (z.B. "Nennbetrag 50.000,00 EUR; Zinsen 1.791,67 EUR")
- sicherheit: Nur wenn eine konkrete Sicherheit genannt ist
- ist_antragsteller: true wenn dieser Gläubiger den Insolvenzantrag gestellt hat

Für betroffene_arbeitnehmer: Extrahiere alle namentlich oder zahlenmäßig genannten betroffenen Arbeitnehmer als Objekte mit {anzahl, typ, quelle}.

gesamtforderungen, gesicherte_forderungen, ungesicherte_forderungen: Auf null setzen — werden automatisch berechnet.

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks):
{
  "einzelforderungen": [
    {
      "glaeubiger": {"wert": "Name", "quelle": "Seite X"},
      "art": "sonstige",
      "rang": "§38 Insolvenzforderung",
      "betrag": {"wert": null, "quelle": ""},
      "titel": {"wert": "Beschreibung mit Teilbeträgen", "quelle": "Seite X"},
      "ist_antragsteller": false
    }
  ],
  "gesamtforderungen": {"wert": null, "quelle": ""},
  "gesicherte_forderungen": {"wert": null, "quelle": ""},
  "ungesicherte_forderungen": {"wert": null, "quelle": ""},
  "betroffene_arbeitnehmer": []
}`;

// ─── Main ───

export async function extractForderungen(
  pageTexts: string[],
  relevantPages: number[] | undefined,
  documentMap: string | undefined,
  ocrResult?: OcrResult | null,
  pdfBuffer?: Buffer | null,
): Promise<Forderungen | null> {
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
      logger.info('Forderungen-Extraktion: Token-Budget-Guard', {
        totalChars, maxChars: MAX_CHARS, allPages: pageTexts.length, usingPages: pages.length,
      });
    }
    logger.info('Forderungen-Extraktion gestartet', { totalPages: pageTexts.length, usingPages: pages.length });

    const mapBlock = documentMap
      ? `\n--- STRUKTURÜBERSICHT (nur zur Orientierung) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
      : '';

    // Build page block — enriched with table structures + confidence if OCR data available
    const pageBlock = ocrResult
      ? buildEnrichedPageBlock(ocrResult, pages, pageTexts)
      : pages.map((pageNum) => `=== SEITE ${pageNum} ===\n${pageTexts[pageNum - 1] ?? ''}`).join('\n\n');

    const textContent = `${FORDERUNGEN_PROMPT}${mapBlock}\n--- AKTENINHALT (${pages.length} Seiten) ---\n\n${pageBlock}`;

    // Build content blocks: text + page images (if PDF available, max 50 pages for forderungen)
    let messageContent: string | Array<{ type: string; [key: string]: unknown }> = textContent;
    if (pdfBuffer && pages.length <= 50) {
      const pageImages = renderPagesToJpeg(pdfBuffer, pages.map(p => p - 1));
      if (pageImages.size > 0) {
        const blocks: Array<{ type: string; [key: string]: unknown }> = [];
        blocks.push({ type: 'text', text: textContent });
        blocks.push({ type: 'text', text: '\n--- BILDANSICHT (für Tabellen, Gläubigerlisten) ---' });
        for (const pageNum of pages) {
          const b64 = pageImages.get(pageNum - 1);
          if (b64) {
            blocks.push({ type: 'text', text: `=== BILD SEITE ${pageNum} ===` });
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
          }
        }
        messageContent = blocks;
        logger.info('Forderungen-Extraktion: Bild+Text-Modus', { images: pageImages.size, textPages: pages.length });
      }
    }

    // Use EXTRACTION_MODEL (Sonnet) — Haiku drops creditor names from long tables
    const model = config.EXTRACTION_MODEL;

    const response = await callWithRetry(() =>
      createAnthropicMessage({
        model,
        max_tokens: 16384,
        temperature: 0,
        messages: [{ role: 'user' as const, content: messageContent as any }],
      })
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
        logger.info('Forderungen-JSON per jsonrepair repariert');
      } catch (repairErr) {
        logger.error('Forderungen-JSON konnte nicht geparst werden', {
          error: repairErr instanceof Error ? repairErr.message : String(repairErr),
          sample: jsonStr.slice(0, 300),
        });
        return null;
      }
    }

    // Validate with Zod schema
    const result = forderungenSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 5);
      logger.warn('Forderungen-Schema-Validierung: Abweichungen', {
        issueCount: result.error.issues.length,
        paths: issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
      return (parsed ?? null) as Forderungen | null;
    }

    const forderungen = result.data as unknown as Forderungen;

    logger.info('Forderungen-Extraktion abgeschlossen', {
      einzelforderungen: forderungen.einzelforderungen.length,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    return forderungen;
  } catch (err) {
    logger.error('Forderungen-Extraktion fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
