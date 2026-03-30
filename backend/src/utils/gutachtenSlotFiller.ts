import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import { processDocxParagraphs } from './gutachtenGenerator';
import type { ExtractionResult } from '../types/extraction';

// --- Types ---

export interface SlotInfo {
  id: string;
  context: string;
  original: string;
}

export interface GutachtenSlot extends SlotInfo {
  value: string;
  hint: string;
  status: 'filled' | 'todo' | 'editorial';
}

// --- Slot Patterns ---

// Matches: [...], [...], [any text up to 80 chars] (but NOT [TODO:...]), xxxx+
const SLOT_PATTERN = /\[\u2026\]|\[\.{3}\]|\[(?!TODO:)[^\[\]]{1,80}\]|\bx{4,}\b/gi;

function hasSlotPattern(text: string): boolean {
  const regex = new RegExp(SLOT_PATTERN.source, SLOT_PATTERN.flags);
  return regex.test(text);
}

// --- Extract Slots ---

export function extractSlots(xml: string): { xml: string; slots: SlotInfo[] } {
  const slots: SlotInfo[] = [];
  let counter = 0;

  const resultXml = processDocxParagraphs(
    xml,
    (text) => hasSlotPattern(text),
    (text) => {
      const regex = new RegExp(SLOT_PATTERN.source, SLOT_PATTERN.flags);
      return text.replace(regex, (match) => {
        counter++;
        const id = `SLOT_${String(counter).padStart(3, '0')}`;
        slots.push({ id, context: '', original: match });
        return `[[${id}]]`;
      });
    }
  );

  // Second pass: extract context for each slot from the modified XML
  processDocxParagraphs(
    resultXml,
    (text) => text.includes('[[SLOT_'),
    (text) => {
      const slotIdRegex = /\[\[SLOT_(\d{3})\]\]/g;
      let m;
      while ((m = slotIdRegex.exec(text)) !== null) {
        const idx = parseInt(m[1], 10) - 1;
        if (idx >= 0 && idx < slots.length) {
          const pos = m.index;
          const start = Math.max(0, pos - 80);
          const end = Math.min(text.length, pos + m[0].length + 80);
          slots[idx].context = text.slice(start, end).trim();
        }
      }
      return text;
    }
  );

  return { xml: resultXml, slots };
}

// --- Apply Slots ---

export function applySlots(
  xml: string,
  filledSlots: { id: string; value: string }[]
): string {
  const slotMap = new Map(filledSlots.map(s => [s.id, s.value]));

  return processDocxParagraphs(
    xml,
    (text) => text.includes('[[SLOT_'),
    (text) => {
      return text.replace(/\[\[SLOT_\d{3}\]\]/g, (match) => {
        const id = match.slice(2, -2);
        return slotMap.get(id) ?? match;
      });
    }
  );
}

// --- Flatten ExtractionResult to .wert values only ---
// Complete data available for slot filling - includes ALL extracted sections

function flattenResult(result: ExtractionResult): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  function walk(obj: unknown, prefix: string): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      flat[prefix] = obj.map(item => {
        if (item && typeof item === 'object' && 'wert' in item) return (item as { wert: unknown }).wert;
        return item;
      });
      return;
    }
    const o = obj as Record<string, unknown>;
    if ('wert' in o) {
      flat[prefix] = o.wert;
      return;
    }
    for (const [key, val] of Object.entries(o)) {
      if (key === 'quelle' || key === 'verifiziert' || key === 'pruefstatus') continue;
      walk(val, prefix ? `${prefix}.${key}` : key);
    }
  }

  // Core case data
  walk(result.verfahrensdaten, 'verfahrensdaten');
  walk(result.schuldner, 'schuldner');
  walk(result.antragsteller, 'antragsteller');
  walk(result.gutachterbestellung, 'gutachterbestellung');
  walk(result.ermittlungsergebnisse, 'ermittlungsergebnisse');

  // Forderungen (summary + individual claims)
  walk(result.forderungen, 'forderungen');
  if (result.forderungen?.einzelforderungen) {
    flat['forderungen.einzelforderungen'] = result.forderungen.einzelforderungen.map(f => ({
      glaeubiger: f.glaeubiger?.wert,
      art: f.art,
      rang: f.rang,
      betrag: f.betrag?.wert,
      titel: f.titel?.wert,
      ist_antragsteller: f.ist_antragsteller,
      sicherheit: f.sicherheit ? {
        art: f.sicherheit.art,
        gegenstand: f.sicherheit.gegenstand?.wert,
        geschaetzter_wert: f.sicherheit.geschaetzter_wert?.wert,
      } : null,
    }));
  }

  // Aktiva
  if (result.aktiva) {
    const aktiva = result.aktiva;
    flat['aktiva.summe_aktiva'] = aktiva.summe_aktiva?.wert;
    flat['aktiva.massekosten_schaetzung'] = aktiva.massekosten_schaetzung?.wert;
    flat['aktiva.positionen'] = aktiva.positionen.map(p => ({
      beschreibung: p.beschreibung?.wert,
      geschaetzter_wert: p.geschaetzter_wert?.wert,
      kategorie: p.kategorie,
    }));
    if (aktiva.insolvenzanalyse) {
      flat['aktiva.insolvenzanalyse'] = aktiva.insolvenzanalyse;
    }
  }

  // Anfechtung (previously missing)
  if (result.anfechtung) {
    flat['anfechtung.zusammenfassung'] = result.anfechtung.zusammenfassung;
    flat['anfechtung.gesamtpotenzial'] = result.anfechtung.gesamtpotenzial?.wert;
    flat['anfechtung.vorgaenge'] = result.anfechtung.vorgaenge.map(v => ({
      beschreibung: v.beschreibung?.wert,
      betrag: v.betrag?.wert,
      datum: v.datum?.wert,
      empfaenger: v.empfaenger?.wert,
      grundlage: v.grundlage,
      risiko: v.risiko,
      begruendung: v.begruendung,
    }));
  }

  // Summary-level intelligence (previously missing)
  if (result.zusammenfassung?.length) {
    flat['zusammenfassung'] = result.zusammenfassung.map(z => z.wert).filter(Boolean);
  }
  if (result.risiken_hinweise?.length) {
    flat['risiken_hinweise'] = result.risiken_hinweise.map(r => r.wert).filter(Boolean);
  }
  if (result.fristen?.length) {
    flat['fristen'] = result.fristen.map(f => ({
      bezeichnung: f.bezeichnung,
      datum: f.datum,
      status: f.status,
    }));
  }
  if (result.fehlende_informationen?.length) {
    flat['fehlende_informationen'] = result.fehlende_informationen.map(f => ({
      information: f.information,
      grund: f.grund,
    }));
  }

  return flat;
}

// --- Slot classification for extraction/interpretation split ---

/** Detect if a slot requires narrative/interpretive prose vs. factual data */
function isNarrativeSlot(slot: SlotInfo): boolean {
  const text = (slot.context + ' ' + slot.original).toLowerCase();
  return /begr.{0,3}ndung|darstellung|feststellung|ausf.{0,3}hrung|bewertung|ergebnis|zusammenfassung|schlussfolgerung|empfehlung|einsch.{0,3}tzung|analyse|pr.{0,3}fung|w.{0,3}rdigung|stellungnahme/.test(text);
}

// --- Fill Slots via Claude API ---
// Architecture: Extraction/Interpretation Split
// - FACTUAL slots (dates, names, amounts) -> filled from data, Haiku validates
// - NARRATIVE slots (analysis, conclusions) -> Sonnet generates grounded prose

const FACTUAL_PROMPT = `Du bist ein spezialisierter KI-Assistent fuer deutsche Insolvenzverwalter. Du erhaeltst Platzhalter (Slots) aus einer Gutachten-Vorlage mit Kontext und extrahierte Daten aus der Gerichtsakte.

WICHTIG -- EXTRAKTION, NICHT INTERPRETATION:
- Du fuellst Slots NUR mit Fakten, die direkt in den bereitgestellten Daten stehen.
- Du INTERPRETIERST NICHT, du ERWEITERST NICHT, du SCHLUSSFOLGERST NICHT.
- Wenn ein Datum, Name oder Betrag nicht in den Daten steht: "[TODO: ...]"
- Datumsformat: TT.MM.JJJJ. Betraege: deutsche Schreibweise (1.234,56 EUR).
- Redaktionelle Anweisungen ([wenn...], [ggf....]): "[TODO: ...]" mit Originaltext als Hinweis
- "xxxx"-Platzhalter: "[TODO: Datum/Wert eintragen]"
- "hint" ist IMMER eine kurze Beschreibung (3-8 Woerter) was in dieses Feld gehoert.

Antworte AUSSCHLIESSLICH mit validem JSON:
{"SLOT_001": {"value": "18.12.2025", "hint": "Datum Beschluss"}, ...}`;

const NARRATIVE_PROMPT = `Du bist ein erfahrener deutscher Insolvenzverwalter und verfasst Abschnitte fuer ein Gutachten nach Paragraph 5 InsO.

WICHTIG -- INTERPRETATION, ABER QUELLENGEBUNDEN:
- Du erhaeltst Platzhalter aus dem Gutachten und die vollstaendigen extrahierten Daten aus der Akte.
- Fuer jeden Slot schreibst du professionelle juristische Prosa auf Deutsch.
- Jede Aussage MUSS auf den bereitgestellten Daten basieren. Erfinde keine Fakten.
- Betraege im deutschen Format (1.234,56 EUR), Daten als TT.MM.JJJJ.
- Verwende die korrekte Fachterminologie (InsO, ZPO, BGB).
- Fasse dich so knapp wie moeglich -- kein Fuelltext, keine Wiederholungen.
- Wenn die Datenlage fuer eine fundierte Aussage nicht ausreicht: "[TODO: Angaben ergaenzen -- ...]"
- "hint" ist IMMER eine kurze Beschreibung (3-8 Woerter) was in dieses Feld gehoert.

Antworte AUSSCHLIESSLICH mit validem JSON:
{"SLOT_001": {"value": "Die Zahlungsunfaehigkeit...", "hint": "Begruendung Insolvenzgrund"}, ...}`;

export async function fillSlots(
  slots: SlotInfo[],
  result: ExtractionResult
): Promise<GutachtenSlot[]> {
  if (slots.length === 0) return [];

  const flatData = flattenResult(result);

  // Split slots by type: factual vs. narrative
  const factualSlots = slots.filter(s => !isNarrativeSlot(s));
  const narrativeSlots = slots.filter(s => isNarrativeSlot(s));

  logger.info('Slot classification', {
    total: slots.length,
    factual: factualSlots.length,
    narrative: narrativeSlots.length,
  });

  // Fill both in parallel
  const [factualResults, narrativeResults] = await Promise.all([
    factualSlots.length > 0
      ? fillSlotBatch(factualSlots, flatData, FACTUAL_PROMPT, config.UTILITY_MODEL || 'claude-haiku-4-5-20251001')
      : Promise.resolve(new Map<string, { value: string; hint: string }>()),
    narrativeSlots.length > 0
      ? fillSlotBatch(narrativeSlots, flatData, NARRATIVE_PROMPT, config.EXTRACTION_MODEL || 'claude-sonnet-4-6')
      : Promise.resolve(new Map<string, { value: string; hint: string }>()),
  ]);

  // Merge results
  const allResults = new Map([...factualResults, ...narrativeResults]);

  return slots.map(s => {
    const entry = allResults.get(s.id);
    const value = entry?.value ?? '';
    const hint = entry?.hint ?? '';

    let status: 'filled' | 'todo' | 'editorial';
    if (value.startsWith('[TODO:')) {
      status = s.original.length > 20 && /wenn|ggf|ansonsten|falls/i.test(s.original)
        ? 'editorial'
        : 'todo';
    } else if (value) {
      status = 'filled';
    } else {
      status = 'todo';
      return { ...s, value: `[TODO: ${s.original}]`, hint: hint || s.original, status };
    }
    return { ...s, value, hint: hint || s.original, status };
  });
}

async function fillSlotBatch(
  slots: SlotInfo[],
  flatData: Record<string, unknown>,
  systemPrompt: string,
  model: string
): Promise<Map<string, { value: string; hint: string }>> {
  const slotList = slots.map(s =>
    `${s.id}: Kontext="${s.context}" Original="${s.original}"`
  ).join('\n');

  const content = `${systemPrompt}\n\n--- EXTRAHIERTE DATEN ---\n${JSON.stringify(flatData, null, 2)}\n\n--- SLOTS ZUM FUELLEN (${slots.length} Stueck) ---\n${slotList}`;

  try {
    const response = await callWithRetry(() =>
      anthropic.messages.create({
        model,
        max_tokens: 8192,
        temperature: 0.1,
        messages: [{ role: 'user' as const, content }],
      })
    ) as Anthropic.Message;

    const text = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c: Anthropic.TextBlock) => c.text)
      .join('');

    let parsed: Record<string, { value: string; hint: string } | string>;
    try {
      const jsonStr = extractJsonFromText(text);
      parsed = JSON.parse(jsonStr);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(text));
      } catch {
        logger.error('Slot-Fill JSON parse failed', { model, sample: text.slice(0, 300) });
        parsed = {};
      }
    }

    logger.info('Slot batch completed', {
      model,
      total: slots.length,
      filled: Object.keys(parsed).length,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    const resultMap = new Map<string, { value: string; hint: string }>();
    for (const s of slots) {
      const entry = parsed[s.id];
      const value = entry && typeof entry === 'object' ? (entry.value ?? '') : String(entry ?? '');
      const hint = entry && typeof entry === 'object' ? (entry.hint ?? '') : '';
      resultMap.set(s.id, { value, hint });
    }
    return resultMap;
  } catch (err) {
    logger.error('Slot-Fill API call failed', {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    const resultMap = new Map<string, { value: string; hint: string }>();
    for (const s of slots) {
      resultMap.set(s.id, { value: `[TODO: ${s.original}]`, hint: s.original });
    }
    return resultMap;
  }
}
