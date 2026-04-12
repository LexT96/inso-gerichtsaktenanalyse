/**
 * Aktiva/Vermögenswerte extraction — Stage 2b of the pipeline.
 *
 * Separate Claude API call to identify and categorize assets from
 * the court file. Runs after main extraction (Stage 2) and before
 * semantic verification (Stage 3).
 *
 * Graceful degradation: returns null on any failure so the pipeline
 * continues without asset data.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import { callWithRetry, extractJsonFromText, createAnthropicMessage } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import type { AktivaAnalyse } from '../types/extraction';

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

const aktivaKategorieSchema = z.enum([
  'immobilien',
  'fahrzeuge',
  'bankguthaben',
  'lebensversicherungen',
  'wertpapiere_beteiligungen',
  'forderungen_schuldner',
  'bewegliches_vermoegen',
  'geschaeftsausstattung',
  'steuererstattungen',
  'einkommen',
]);

const aktivumSchema = z.object({
  beschreibung: sourcedValueSchema,
  geschaetzter_wert: sourcedNumberSchema,
  kategorie: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase().trim() : v),
    aktivaKategorieSchema
  ),
  liquidationswert: sourcedNumberSchema.optional(),
  fortfuehrungswert: sourcedNumberSchema.optional(),
  absonderung: sourcedNumberSchema.optional(),
  aussonderung: sourcedNumberSchema.optional(),
  freie_masse: sourcedNumberSchema.optional(),
  sicherungsrechte: z.string().optional(),
});

const insolvenzgrundBewertungSchema = z.object({
  status: z.preprocess(
    (v) => {
      const s = String(v ?? 'offen').toLowerCase().trim();
      if (s === 'ja' || s === 'true') return 'ja';
      if (s === 'nein' || s === 'false') return 'nein';
      return 'offen';
    },
    z.enum(['ja', 'nein', 'offen'])
  ),
  begruendung: z.preprocess((v) => String(v ?? ''), z.string()),
});

const insolvenzanalyseSchema = z.object({
  zahlungsunfaehigkeit_17: insolvenzgrundBewertungSchema,
  drohende_zahlungsunfaehigkeit_18: insolvenzgrundBewertungSchema,
  ueberschuldung_19: insolvenzgrundBewertungSchema,
  massekostendeckung_26: insolvenzgrundBewertungSchema,
  gesamtbewertung: z.preprocess((v) => String(v ?? ''), z.string()),
});

const aktivaAnalyseSchema = z.object({
  positionen: z.preprocess(
    (v) => (Array.isArray(v) ? v : []),
    z.array(aktivumSchema)
  ),
  summe_aktiva: sourcedNumberSchema,
  massekosten_schaetzung: sourcedNumberSchema,
  insolvenzanalyse: insolvenzanalyseSchema.optional(),
});

// ─── Prompt ───

const AKTIVA_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter mit über 30 Jahren Erfahrung im Insolvenzrecht. Analysiere die Gerichtsakte und:
1. Extrahiere ALLE Vermögenswerte (Aktiva) des Schuldners
2. Erstelle eine fundierte Insolvenzanalyse (Vergleich Aktiva vs. Passiva)

PFLICHT: Jedes Feld mit ausgefülltem "wert" MUSS eine "quelle" haben. Format: "Seite X, [Dokument/Abschnitt]". Die quelle muss die tatsächliche Fundstelle sein — die Seite, auf der du den Wert im vorliegenden Dokument gefunden hast.
Datumsformat: TT.MM.JJJJ. Beträge: IMMER in EUR (nicht TEUR) als reine Zahl ohne Tausendertrennzeichen (z.B. 100000.00 NICHT 100.000,00). WICHTIG: Wenn Beträge im Dokument in TEUR angegeben sind, multipliziere mit 1000 um auf EUR umzurechnen (z.B. 898 TEUR → 898000).

Identifiziere Vermögenswerte in diesen 10 Kategorien:
1. immobilien — Grundstücke, Häuser, Wohnungen, Grundbesitz (beachte: belastete Grundstücke — Grundschulden, Hypotheken abziehen!)
2. fahrzeuge — PKW, LKW, Motorräder (Zeitwert, nicht Neuwert; sicherungsübereignete Fahrzeuge kennzeichnen)
3. bankguthaben — Konten, Guthaben bei Banken/Sparkassen (beachte Pfändungsschutzkonto § 850k ZPO)
4. lebensversicherungen — Lebens-/Rentenversicherungen mit Rückkaufswert (nur verwertbarer Anteil)
5. wertpapiere_beteiligungen — Aktien, Fonds, GmbH-Anteile, Beteiligungen
6. forderungen_schuldner — Forderungen des Schuldners gegen Dritte (Einbringlichkeit bewerten!)
7. bewegliches_vermoegen — Schmuck, Kunst, Sammlungen, sonstige Wertgegenstände (unpfändbare Haushaltsgegenstände § 811 ZPO nicht mitzählen)
8. geschaeftsausstattung — Büroausstattung, Maschinen, Warenlager
9. steuererstattungen — erwartete Steuererstattungsansprüche
10. einkommen — laufendes Einkommen, Gehalt, Rente, Sozialleistungen (NUR pfändbarer Anteil nach § 850c ZPO, Pfändungsfreigrenzen berücksichtigen)

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks). In allen String-Werten Anführungszeichen mit \\ escapen, keine Zeilenumbrüche innerhalb von Strings. Bei Beträgen: Nur 0 setzen, wenn der Wert tatsächlich 0 in der Akte steht — sonst null und quelle leer lassen.

{
  "positionen": [
    {
      "beschreibung": {"wert": "Beschreibung des Vermögenswerts", "quelle": "Seite X, Abschnitt"},
      "geschaetzter_wert": {"wert": 0, "quelle": "Seite X, Abschnitt"},
      "kategorie": "immobilien",
      "liquidationswert": {"wert": 0, "quelle": ""},
      "fortfuehrungswert": {"wert": 0, "quelle": ""},
      "absonderung": {"wert": 0, "quelle": ""},
      "aussonderung": {"wert": 0, "quelle": ""},
      "freie_masse": {"wert": null, "quelle": ""},
      "sicherungsrechte": "z.B. Grundschuld zugunsten Sparkasse, Sicherungsübereignung zugunsten Bank"
    }
  ],
  "summe_aktiva": {"wert": null, "quelle": ""},
  "massekosten_schaetzung": {"wert": 0, "quelle": ""},
  "insolvenzanalyse": {
    "zahlungsunfaehigkeit_17": {
      "status": "ja|nein|offen",
      "begruendung": "Ausführliche Begründung: Kann der Schuldner seine fälligen Verbindlichkeiten begleichen? Liquiditätslage bewerten. Berücksichtige: verfügbare liquide Mittel vs. fällige Forderungen, laufende Einnahmen vs. laufende Verpflichtungen."
    },
    "drohende_zahlungsunfaehigkeit_18": {
      "status": "ja|nein|offen",
      "begruendung": "Begründung: Wird der Schuldner voraussichtlich künftige Zahlungspflichten nicht erfüllen können? Prognostische Bewertung unter Berücksichtigung der Einkommensverhältnisse und absehbaren Entwicklungen."
    },
    "ueberschuldung_19": {
      "status": "ja|nein|offen",
      "begruendung": "Begründung: Übersteigen die Verbindlichkeiten das Vermögen? NUR relevant bei juristischen Personen und Gesellschaften ohne natürliche Person als Vollhafter. Bei natürlichen Personen: status=offen, Begründung='Überschuldung ist kein Insolvenzgrund für natürliche Personen'."
    },
    "massekostendeckung_26": {
      "status": "ja|nein|offen",
      "begruendung": "Begründung: Reicht das verwertbare Vermögen zur Deckung der Verfahrenskosten (Gerichtskosten + Verwaltervergütung)? Mindestmasse nach § 26 InsO schätzen. Berücksichtige: Absonderungsrechte, Aus- und Absonderungsberechtigte reduzieren die freie Masse."
    },
    "gesamtbewertung": "Zusammenfassende Einschätzung: Liegen die Voraussetzungen für die Eröffnung des Insolvenzverfahrens vor? Ist die Masse voraussichtlich kostendeckend? Welche Vermögenswerte sind verwertbar, welche belastet/gepfändet? Empfehlung für den Insolvenzverwalter."
  }
}

REGELN FÜR VERMÖGENSWERTE:
- Nur extrahieren, was tatsächlich im Dokument steht. Keine Werte erfinden.
- Wenn keine Vermögenswerte gefunden werden, leere positionen-Liste zurückgeben.
- geschaetzter_wert: Den im Dokument genannten Wert verwenden (= Liquidationswert oder bester verfügbarer Wert). Wenn kein Wert genannt, null setzen.
- liquidationswert / fortfuehrungswert: Wenn das Dokument beide Werte nennt, beide extrahieren. Sonst: liquidationswert = geschaetzter_wert, fortfuehrungswert leer.
- absonderung: Wert der Absonderungsrechte (z.B. Grundschuld, Sicherungsübereignung) an diesem Vermögenswert. 0 wenn keine Absonderung.
- aussonderung: Wert der Aussonderungsrechte (z.B. Eigentumsvorbehalt, Leasing) an diesem Vermögenswert. 0 wenn keine Aussonderung.
- freie_masse: Auf null setzen — wird automatisch vom System berechnet (geschaetzter_wert - absonderung - aussonderung). NIEMALS selbst berechnen.
- sicherungsrechte: Textbeschreibung der Sicherheiten (z.B. "Grundschuld zugunsten Sparkasse Trier i.H.v. 154.000 EUR")
- summe_aktiva: Auf null setzen — wird automatisch vom System aus den Einzelpositionen berechnet. NIEMALS selbst addieren.
- massekosten_schaetzung: Geschätzte Massekosten nach § 54 InsO (Gerichtskosten ca. 2.000-4.000 EUR + Verwaltervergütung nach InsVV).
- Jede Position braucht eine kategorie aus der obigen Liste.
- ERINNERUNG: Jeder nicht-leere wert braucht eine quelle (Seite X, ...). Keine Ausnahme.

REGELN FÜR INSOLVENZANALYSE:
- Bewerte jeden Insolvenzgrund (§§ 17, 18, 19 InsO) separat mit "ja" (liegt vor), "nein" (liegt nicht vor) oder "offen" (aus der Akte nicht eindeutig feststellbar).
- Die Begründung MUSS konkret sein — beziehe dich auf die tatsächlichen Zahlen und Fakten aus der Akte. Keine generischen Phrasen.
- Berücksichtige bei der Bewertung: Belastungen auf Vermögenswerten (Grundschulden, Sicherungsübereignungen), Pfändungsfreigrenzen (§ 850c ZPO), Absonderungsrechte (§§ 49-51 InsO), unpfändbare Gegenstände (§ 811 ZPO).
- Die Gesamtbewertung soll eine prägnante, praxisorientierte Zusammenfassung für den Insolvenzverwalter sein.
- Auch wenn die Akte unvollständig ist: Gib eine vorläufige Einschätzung ab und benenne explizit, welche Informationen für eine abschließende Bewertung noch fehlen.

Wenn eine DOKUMENTSTRUKTUR mitgegeben wird, nutze sie NUR um zu verstehen welcher Dokumentteil was enthält. Die SEITENZAHLEN in der quelle müssen von der EXAKTEN Seite kommen, auf der du den Wert im Akteninhalt findest — NICHT aus der Dokumentstruktur-Übersicht.`;

// ─── Hints from existing extraction ───

function buildHints(existingResult: { ermittlungsergebnisse?: any; forderungen?: any }): string {
  const hints: string[] = [];

  const ermittlung = existingResult?.ermittlungsergebnisse;
  if (ermittlung) {
    if (ermittlung.grundbuch?.grundbesitz_vorhanden?.wert === true) {
      hints.push('- Grundbesitz ist laut Grundbuchauskunft VORHANDEN — suche nach Immobilien-Details.');
    } else if (ermittlung.grundbuch?.grundbesitz_vorhanden?.wert === false) {
      hints.push('- Grundbesitz ist laut Grundbuchauskunft NICHT vorhanden.');
    }

    if (ermittlung.gerichtsvollzieher?.masse_deckend?.wert === true) {
      hints.push('- Masse wird als deckend eingeschätzt — es sollten verwertbare Vermögenswerte vorhanden sein.');
    } else if (ermittlung.gerichtsvollzieher?.masse_deckend?.wert === false) {
      hints.push('- Masse wird als NICHT deckend eingeschätzt.');
    }

    if (ermittlung.gerichtsvollzieher?.vermoegensauskunft_abgegeben?.wert === true) {
      hints.push('- Vermögensauskunft wurde abgegeben — Details können Hinweise auf Vermögenswerte enthalten.');
    }
  }

  const forderungen = existingResult?.forderungen;
  const gesamtWert = forderungen?.gesamtforderungen?.wert ?? forderungen?.gesamtforderung?.wert;
  if (gesamtWert && typeof gesamtWert === 'number') {
    hints.push(`- Gesamtforderungen: ${gesamtWert.toLocaleString('de-DE')} EUR — setze dies in Relation zu den gefundenen Vermögenswerten.`);
  }
  if (forderungen?.gesicherte_forderungen?.wert && typeof forderungen.gesicherte_forderungen.wert === 'number') {
    hints.push(`- Davon gesichert: ${forderungen.gesicherte_forderungen.wert.toLocaleString('de-DE')} EUR`);
  }

  return hints.length > 0
    ? `\n--- HINWEISE AUS BISHERIGER ANALYSE ---\n${hints.join('\n')}\n--- ENDE HINWEISE ---\n`
    : '';
}

// ─── Main ───

export async function extractAktiva(
  pageTexts: string[],
  documentMap: string | undefined,
  existingResult: { ermittlungsergebnisse?: any; forderungen?: any },
  relevantPages?: number[],
): Promise<AktivaAnalyse | null> {
  try {
    // Use all pages by default. Only use routed subset if all pages exceed token limit.
    const MAX_CHARS = 450_000; // ~180K tokens at 2.5 chars/tok, under 200K API limit
    let pages = pageTexts.map((_, i) => i + 1);
    const totalChars = pageTexts.reduce((sum, t) => sum + t.length, 0);

    if (totalChars > MAX_CHARS) {
      // First try: use routed pages
      if (relevantPages && relevantPages.length < pages.length) {
        pages = relevantPages;
      }
      // Second check: if routed pages still exceed budget, truncate to fit
      let charSum = 0;
      const fittingPages: number[] = [];
      for (const p of pages) {
        charSum += (pageTexts[p - 1] ?? '').length + 20; // +20 for header
        if (charSum > MAX_CHARS) break;
        fittingPages.push(p);
      }
      if (fittingPages.length < pages.length) {
        pages = fittingPages;
      }
      logger.info('Aktiva-Extraktion: Token-Budget-Guard', {
        totalChars, maxChars: MAX_CHARS, allPages: pageTexts.length, usingPages: pages.length,
      });
    }
    logger.info('Aktiva-Extraktion gestartet', { totalPages: pageTexts.length, usingPages: pages.length });

    const mapBlock = documentMap
      ? `\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
      : '';

    const hintsBlock = buildHints(existingResult);

    const pageBlock = pages
      .map((pageNum) => `=== SEITE ${pageNum} ===\n${pageTexts[pageNum - 1] ?? ''}`)
      .join('\n\n');

    const content = `${AKTIVA_PROMPT}${mapBlock}${hintsBlock}\n--- AKTENINHALT (${pages.length} Seiten) ---\n\n${pageBlock}`;

    const model = config.UTILITY_MODEL || 'claude-haiku-4-5-20251001';

    const response = await callWithRetry(() =>
      createAnthropicMessage({
        model,
        max_tokens: 4096,
        temperature: 0.1,
        messages: [{ role: 'user' as const, content }],
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
        logger.info('Aktiva-JSON per jsonrepair repariert');
      } catch (repairErr) {
        logger.error('Aktiva-JSON konnte nicht geparst werden', {
          error: repairErr instanceof Error ? repairErr.message : String(repairErr),
          sample: jsonStr.slice(0, 300),
        });
        return null;
      }
    }

    // Validate with Zod schema
    const result = aktivaAnalyseSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.slice(0, 5);
      logger.warn('Aktiva-Schema-Validierung: Abweichungen', {
        issueCount: result.error.issues.length,
        paths: issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
      // Try to use parsed data directly as fallback
      return (parsed ?? null) as AktivaAnalyse | null;
    }

    const aktiva = result.data as unknown as AktivaAnalyse;

    logger.info('Aktiva-Extraktion abgeschlossen', {
      positionen: aktiva.positionen.length,
      summe: aktiva.summe_aktiva?.wert ?? null,
      massekosten: aktiva.massekosten_schaetzung?.wert ?? null,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    return aktiva;
  } catch (err) {
    logger.error('Aktiva-Extraktion fehlgeschlagen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
