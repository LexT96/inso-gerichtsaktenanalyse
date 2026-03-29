/**
 * Enrichment Review — Stage 4 of the pipeline.
 *
 * After extraction (Stage 2) and verification (Stage 3), this stage
 * reviews the extraction result for INFERENCE ERRORS — cases where
 * the model chose the wrong value because it mixed up extraction
 * (what does the document literally say?) with classification
 * (what does it mean?).
 *
 * Known error patterns from real-world testing:
 * 1. Betriebsstätte = Privatanschrift bei Einzelunternehmern
 * 2. Zustellungsdatum = Briefdatum statt PZU-Stempel
 * 3. Forderungsbetrag: Antragssumme vs. Leistungsbescheid-Summe (verschiedene Daten)
 *
 * Uses a focused Haiku call with specific questions — cheap and fast.
 */

import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import type { ExtractionResult } from '../types/extraction';

const REVIEW_PROMPT = `Du bist ein Qualitätsprüfer für eine Insolvenz-Aktenextraktion. Du erhältst eine bereits durchgeführte Extraktion und den Akteninhalt. Prüfe NUR die folgenden spezifischen Fehlerquellen und korrigiere sie falls nötig.

PRÜFUNG 1 — BETRIEBSSTÄTTE vs. PRIVATANSCHRIFT:
Wenn der Schuldner ein Einzelunternehmer ist und betriebsstaette_adresse die gleiche Straße+Hausnummer hat wie aktuelle_adresse:
- Suche im Insolvenzantrag nach der Adresse die UNTER oder NEBEN dem Firmennamen steht
- Diese Adresse im Antrag IST die Betriebsstätte — auch wenn sie sich von der Meldeadresse unterscheidet
- Die Meldeauskunft zeigt die PRIVATANSCHRIFT, nicht die Betriebsstätte
- WICHTIG: Wenn der Antrag eine andere Hausnummer nennt als die Meldeauskunft (z.B. Antrag sagt "Niederstraße 87", Meldeauskunft sagt "Niederstraße 118"), dann ist die Antrag-Adresse die Betriebsstätte und MUSS korrigiert werden
- Dass der GV die Betriebsstätte "nicht kennt" oder "nicht bestätigen kann" ändert NICHTS — der Antrag ist die primäre Quelle
- Korrigiere betriebsstaette_adresse auf die Adresse aus dem Insolvenzantrag

PRÜFUNG 2 — ZUSTELLUNGSDATUM:
- Das zustellungsdatum_schuldner muss das Datum der ZUSTELLUNG sein, nicht das Datum des Schreibens
- Suche nach: Postzustellungsurkunde (PZU), gelbe Zustellungsurkunde, Stempel mit Datum, "Erledigt... Datum:", handschriftliches Datum im Zustellvermerk
- Wenn das extrahierte Datum = Datum des Schreibens und ein späteres PZU-Datum existiert: korrigiere

PRÜFUNG 3 — WIDERSPRÜCHLICHE BETRÄGE:
- Wenn mehrere Gesamtbeträge in verschiedenen Dokumenten stehen (z.B. Antrag vs. Leistungsbescheid):
- Der ANTRAG hat den aktuelleren/höheren Betrag (enthält zusätzliche Säumniszuschläge/Mahngebühren)
- Melde den Widerspruch als Warnung

Antworte AUSSCHLIESSLICH mit validem JSON:
{
  "korrekturen": [
    {"feld": "betriebsstaette_adresse", "alter_wert": "...", "neuer_wert": "...", "begruendung": "..."},
    {"feld": "zustellungsdatum_schuldner", "alter_wert": "...", "neuer_wert": "...", "begruendung": "..."}
  ],
  "warnungen": [
    {"typ": "betrag_widerspruch", "text": "Antrag nennt X EUR, Leistungsbescheid Y EUR"}
  ]
}

Wenn KEINE Korrekturen nötig: {"korrekturen": [], "warnungen": []}
Erfinde KEINE Korrekturen — nur korrigieren wenn du den richtigen Wert im Dokument FINDEST.`;

export async function enrichmentReview(
  result: ExtractionResult,
  pageTexts: string[]
): Promise<ExtractionResult> {
  // Only run if there are fields to check
  const betriebsstaette = result.schuldner?.betriebsstaette_adresse?.wert;
  const privatadresse = result.schuldner?.aktuelle_adresse?.wert;
  const zustelldatum = result.verfahrensdaten?.zustellungsdatum_schuldner?.wert;
  const rechtsform = String(result.schuldner?.rechtsform?.wert ?? '').toLowerCase();

  // Extract street name + number for fuzzy address comparison
  function extractStreetKey(addr: string): string {
    // Match "Straße/str/weg/platz/gasse + number" pattern
    const match = addr.match(/([A-Za-zÄÖÜäöüß]+(?:stra[ßs]e|str\.|weg|platz|gasse|allee|ring|damm))\s*(\d+)/i);
    if (match) return `${match[1].toLowerCase()} ${match[2]}`;
    // Fallback: first word + first number
    const words = addr.replace(/[,;()]/g, ' ').split(/\s+/);
    const num = words.find(w => /^\d+$/.test(w));
    return `${(words[0] || '').toLowerCase()} ${num || ''}`.trim();
  }

  // Skip if nothing to review
  const isEinzelunternehmer = rechtsform.includes('einzelunternehm') || rechtsform.includes('freiberuf');
  const sameStreet = betriebsstaette && privatadresse &&
    extractStreetKey(String(betriebsstaette)) === extractStreetKey(String(privatadresse));
  const betriebsstaetteVerdaechtig = isEinzelunternehmer && !!betriebsstaette && (sameStreet || !betriebsstaette);
  const hatZustelldatum = !!zustelldatum;

  if (!betriebsstaetteVerdaechtig && !hatZustelldatum) {
    logger.debug('Enrichment review skipped — no suspicious patterns');
    return result;
  }

  logger.info('Enrichment review started', {
    betriebsstaetteVerdaechtig,
    hatZustelldatum,
  });

  // Build focused context — only send relevant pages (first 20 + pages with PZU/Zustellung)
  const relevantPageIndices = new Set<number>();
  // Always include first 15 pages (Antrag, Beschluss)
  for (let i = 0; i < Math.min(15, pageTexts.length); i++) relevantPageIndices.add(i);
  // Find pages with Zustellungsurkunde / PZU
  for (let i = 0; i < pageTexts.length; i++) {
    const lower = pageTexts[i].toLowerCase();
    if (lower.includes('zustellungsurkunde') || lower.includes('postzustellung') ||
        lower.includes('pzu') || lower.includes('zustellvermerk') ||
        lower.includes('erledigt') || lower.includes('deutsche post')) {
      relevantPageIndices.add(i);
    }
  }

  const pageBlock = [...relevantPageIndices].sort((a, b) => a - b)
    .map(i => `=== SEITE ${i + 1} ===\n${pageTexts[i]}`)
    .join('\n\n');

  const currentValues = `
AKTUELLE EXTRAKTION:
- betriebsstaette_adresse: "${betriebsstaette || ''}"
- aktuelle_adresse: "${privatadresse || ''}"
- zustellungsdatum_schuldner: "${zustelldatum || ''}"
- rechtsform: "${result.schuldner?.rechtsform?.wert || ''}"
- firma: "${result.schuldner?.firma?.wert || ''}"
- gesamtforderungen: ${result.forderungen?.gesamtforderungen?.wert ?? 'null'}
`;

  const content = `${REVIEW_PROMPT}\n\n${currentValues}\n\n--- RELEVANTE SEITEN ---\n${pageBlock}`;

  try {
    const response = await callWithRetry(() => anthropic.messages.create({
      model: config.UTILITY_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      temperature: 0,
      messages: [{ role: 'user' as const, content }],
    }));

    const text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('');

    const jsonStr = extractJsonFromText(text);
    const parsed = JSON.parse(jsonStr) as {
      korrekturen: Array<{ feld: string; alter_wert: string; neuer_wert: string; begruendung: string }>;
      warnungen: Array<{ typ: string; text: string }>;
    };

    // Apply corrections
    let corrected = 0;
    for (const k of parsed.korrekturen || []) {
      if (!k.feld || !k.neuer_wert) continue;

      if (k.feld === 'betriebsstaette_adresse' && result.schuldner?.betriebsstaette_adresse) {
        logger.info('Enrichment correction: betriebsstaette_adresse', {
          from: result.schuldner.betriebsstaette_adresse.wert,
          to: k.neuer_wert,
          reason: k.begruendung,
        });
        result.schuldner.betriebsstaette_adresse.wert = k.neuer_wert;
        result.schuldner.betriebsstaette_adresse.verifiziert = undefined;
        corrected++;
      }

      if (k.feld === 'zustellungsdatum_schuldner' && result.verfahrensdaten?.zustellungsdatum_schuldner) {
        logger.info('Enrichment correction: zustellungsdatum_schuldner', {
          from: result.verfahrensdaten.zustellungsdatum_schuldner.wert,
          to: k.neuer_wert,
          reason: k.begruendung,
        });
        result.verfahrensdaten.zustellungsdatum_schuldner.wert = k.neuer_wert;
        result.verfahrensdaten.zustellungsdatum_schuldner.verifiziert = undefined;
        corrected++;
      }
    }

    // Add warnings to risiken_hinweise
    for (const w of parsed.warnungen || []) {
      if (w.text && result.risiken_hinweise) {
        result.risiken_hinweise.push({
          wert: `[Plausibilitätsprüfung] ${w.text}`,
          quelle: '',
        });
      }
    }

    logger.info('Enrichment review completed', {
      corrections: corrected,
      warnings: (parsed.warnungen || []).length,
      inputTokens: response.usage?.input_tokens ?? 0,
    });

  } catch (err) {
    logger.warn('Enrichment review failed', { error: err instanceof Error ? err.message : String(err) });
  }

  return result;
}
