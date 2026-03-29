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

// Matches: […], [...], [any text up to 80 chars] (but NOT [TODO:...]), xxxx+
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
          const start = Math.max(0, pos - 60);
          const end = Math.min(text.length, pos + m[0].length + 60);
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

  walk(result.verfahrensdaten, 'verfahrensdaten');
  walk(result.schuldner, 'schuldner');
  walk(result.antragsteller, 'antragsteller');
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
  walk(result.gutachterbestellung, 'gutachterbestellung');
  walk(result.ermittlungsergebnisse, 'ermittlungsergebnisse');

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

  return flat;
}

// --- Fill Slots via Claude API ---

const SLOT_FILL_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter. Du erhältst eine Liste nummerierter Platzhalter (Slots) aus einer Gutachten-Vorlage, zusammen mit dem Kontext (umgebender Satz) und extrahierten Daten aus der Gerichtsakte.

Deine Aufgabe: Fülle jeden Slot mit dem passenden Wert aus den bereitgestellten Daten UND gib einen kurzen Hinweis was in dieses Feld gehört.

REGELN:
- Nur Werte aus den bereitgestellten Daten verwenden, NICHTS erfinden.
- Datumsformat: TT.MM.JJJJ. Beträge: deutsche Schreibweise (1.234,56 EUR).
- Wenn ein Slot aus den Daten NICHT füllbar ist: value = "[TODO: kurze Beschreibung was hier einzutragen ist]"
- Redaktionelle Anweisungen (erkennbar an "wenn...", "ggf.", "ansonsten", "falls", Hinweise an den Anwalt): value = "[TODO: ...]" mit dem Originaltext als Hinweis
- "xxxx"-Platzhalter für zukünftige Daten: value = "[TODO: Datum/Wert eintragen]"
- "[Tabelle]"-Platzhalter: value = "[TODO: Tabelle einfügen]"
- "hint" ist IMMER eine kurze, prägnante Beschreibung (3-8 Wörter) was in dieses Feld gehört. Beispiele: "Datum der Aktenübersendung", "Anzahl Arbeitnehmer", "EUR-Betrag Lohnrückstände", "Name des Steuerberaters", "Ort des Amtsgerichts"

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks). Jeder Slot ist ein Objekt mit "value" und "hint":
{"SLOT_001": {"value": "18.12.2025", "hint": "Datum Beschluss"}, "SLOT_002": {"value": "[TODO: Angabe fehlt]", "hint": "Anzahl Arbeitnehmer"}, ...}`;

export async function fillSlots(
  slots: SlotInfo[],
  result: ExtractionResult
): Promise<GutachtenSlot[]> {
  if (slots.length === 0) return [];

  const flatData = flattenResult(result);

  const slotList = slots.map(s =>
    `${s.id}: Kontext="${s.context}" Original="${s.original}"`
  ).join('\n');

  const content = `${SLOT_FILL_PROMPT}\n\n--- EXTRAHIERTE DATEN ---\n${JSON.stringify(flatData, null, 2)}\n\n--- SLOTS ZUM FÜLLEN (${slots.length} Stück) ---\n${slotList}`;

  const model = config.UTILITY_MODEL || 'claude-haiku-4-5-20251001';

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
        logger.error('Slot-Fill JSON parse failed', { sample: text.slice(0, 300) });
        parsed = {};
      }
    }

    logger.info('Slot-Filling completed', {
      total: slots.length,
      filled: Object.keys(parsed).length,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });

    return slots.map(s => {
      const entry = parsed[s.id];
      // Handle both formats: {value, hint} object or plain string (fallback)
      const value = entry && typeof entry === 'object' ? (entry.value ?? '') : String(entry ?? '');
      const hint = entry && typeof entry === 'object' ? (entry.hint ?? '') : '';

      let status: 'filled' | 'todo' | 'editorial';
      if (value.startsWith('[TODO:')) {
        status = s.original.length > 20 && /wenn|ggf|ansonsten|falls|außerdem/i.test(s.original)
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
  } catch (err) {
    logger.error('Slot-Filling API call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return slots.map(s => ({
      ...s,
      value: `[TODO: ${s.original}]`,
      hint: s.original,
      status: 'todo' as const,
    }));
  }
}
