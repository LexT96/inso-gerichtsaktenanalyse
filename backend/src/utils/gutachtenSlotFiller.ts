import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { anthropic, callWithRetry, extractJsonFromText } from '../services/anthropic';
import { config } from '../config';
import { logger } from './logger';
import { processDocxParagraphs, formatEUR } from './gutachtenGenerator';
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

  // Second pass: extract wider context (200 chars) for each slot
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
          const start = Math.max(0, pos - 150);
          const end = Math.min(text.length, pos + m[0].length + 150);
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
      return text.replace(/\[\[SLOT_\d{3}(?::[^\]]+)?\]\]/g, (match) => {
        const idMatch = match.match(/SLOT_\d{3}/);
        if (!idMatch) return match;
        return slotMap.get(idMatch[0]) ?? match;
      });
    }
  );
}

// --- Deterministic Pre-Fill ---
// Maps slot context patterns to extraction data paths.
// This fills slots BEFORE sending to Claude, ensuring reliable data.

type SlotMatcher = {
  /** Regex patterns to match against slot context (case-insensitive) */
  patterns: RegExp[];
  /** Function that extracts the value from ExtractionResult */
  extract: (r: ExtractionResult) => string | null;
  /** Short hint */
  hint: string;
};

function sv(v: { wert?: unknown } | undefined | null): string | null {
  if (!v || v.wert == null || v.wert === '') return null;
  return String(v.wert);
}

function sn(v: { wert?: number | null } | undefined | null): number | null {
  if (!v || v.wert == null) return null;
  return Number(v.wert);
}

function buildPreFillMatchers(): SlotMatcher[] {
  return [
    // --- Arbeitnehmer (must have [[SLOT_xxx]] directly before "Arbeitnehmer") ---
    {
      patterns: [/\[\[SLOT_\d+\]\]\s*Arbeitnehmer/i],
      extract: (r) => {
        const an = r.forderungen?.betroffene_arbeitnehmer;
        if (an?.length) {
          const total = an.reduce((s, a) => {
            if (typeof a === 'object' && 'anzahl' in a) return s + ((a as { anzahl: number }).anzahl || 0);
            return s;
          }, 0);
          if (total > 0) return String(total);
        }
        // Try ermittlungsergebnisse
        const erm = r.ermittlungsergebnisse as unknown as Record<string, unknown>;
        if (erm) {
          for (const [k, v] of Object.entries(erm)) {
            if (/arbeitnehmer.*anzahl|anzahl.*arbeitnehmer/i.test(k) && v != null) return String(v);
          }
        }
        return null;
      },
      hint: 'Anzahl Arbeitnehmer',
    },
    // --- Auszubildende ---
    {
      patterns: [/auszubildend|ausbildungsverh/i],
      extract: () => null, // Typically not extracted separately
      hint: 'Anzahl Auszubildende',
    },
    // --- Lohnrueckstaende ---
    {
      patterns: [/lohnr.{0,5}ckst.{0,5}nd|lohn.*aufgelaufen/i],
      extract: (r) => {
        const erm = r.ermittlungsergebnisse as unknown as Record<string, unknown>;
        if (erm) {
          for (const [k, v] of Object.entries(erm)) {
            if (/lohn/i.test(k) && v && typeof v === 'object' && 'wert' in v) {
              const val = (v as { wert: unknown }).wert;
              if (val != null) return typeof val === 'number' ? formatEUR(val) : String(val);
            }
          }
        }
        return null;
      },
      hint: 'Lohnrueckstaende',
    },
    // --- Gesamtforderungen / Verbindlichkeiten ---
    {
      patterns: [/gesamtforderung|verbindlichkeiten.*gesamt|gesamt.*verbindlichkeit/i],
      extract: (r) => {
        const v = sn(r.forderungen?.gesamtforderungen);
        return v != null ? formatEUR(v) : null;
      },
      hint: 'Gesamtforderungen',
    },
    // --- Gesicherte Forderungen ---
    {
      patterns: [/gesicherte.*forderung/i],
      extract: (r) => {
        const v = sn(r.forderungen?.gesicherte_forderungen);
        return v != null ? formatEUR(v) : null;
      },
      hint: 'Gesicherte Forderungen',
    },
    // --- Ungesicherte Forderungen ---
    {
      patterns: [/ungesicherte.*forderung|f.{0,3}llige.*verbindlichkeit/i],
      extract: (r) => {
        const v = sn(r.forderungen?.ungesicherte_forderungen);
        return v != null ? formatEUR(v) : null;
      },
      hint: 'Ungesicherte Forderungen',
    },
    // --- Aktiva Summe ---
    {
      patterns: [/summe.*aktiva|aktiva.*summe|freies.*verm.{0,5}gen|massebestand/i],
      extract: (r) => {
        const v = sn(r.aktiva?.summe_aktiva);
        return v != null ? formatEUR(v) : null;
      },
      hint: 'Summe Aktiva',
    },
    // --- Massekosten ---
    {
      patterns: [/massekosten|verfahrenskosten.*gesamt/i],
      extract: (r) => {
        const v = sn(r.aktiva?.massekosten_schaetzung);
        return v != null ? formatEUR(v) : null;
      },
      hint: 'Massekosten',
    },
    // --- Aktiva Positionen (table) ---
    {
      patterns: [/aktiva.{0,5}position|verm.{0,10}gen.{0,5}position|beweglich.*sachanlag/i],
      extract: (r) => {
        const pos = r.aktiva?.positionen;
        if (!pos?.length) return null;
        return pos.map(p => {
          const w = sn(p.geschaetzter_wert);
          return `- ${sv(p.beschreibung) || p.kategorie}: ${w != null ? formatEUR(w) : 'k.A.'}`;
        }).join('\n');
      },
      hint: 'Aktiva-Positionen',
    },
    // --- Passiva / Forderungstabelle ---
    {
      patterns: [/passiva.{0,5}position|forderungen.*tabelle|tabelle.*forderung|insolvenzforderung/i],
      extract: (r) => {
        const ef = r.forderungen?.einzelforderungen;
        if (!ef?.length) return null;
        return ef.map(f => {
          const b = sn(f.betrag);
          return `- ${sv(f.glaeubiger) || 'k.A.'} (${f.art}): ${b != null ? formatEUR(b) : 'k.A.'} [${f.rang}]`;
        }).join('\n');
      },
      hint: 'Forderungsuebersicht',
    },
    // --- Steuerberater ---
    {
      patterns: [/steuerberater|steuerrechtlich.*pflicht/i],
      extract: (r) => {
        const erm = r.ermittlungsergebnisse as unknown as Record<string, unknown>;
        if (erm) {
          for (const [k, v] of Object.entries(erm)) {
            if (/steuerberater/i.test(k) && v && typeof v === 'object' && 'wert' in v) {
              return sv(v as { wert: unknown });
            }
          }
        }
        return null;
      },
      hint: 'Steuerberater',
    },
    // --- Unterhaltspflichten ---
    {
      patterns: [/unterhaltspflicht/i],
      extract: (r) => {
        const v = sn(r.schuldner?.pfaendungsberechnung?.unterhaltspflichten);
        if (v != null) return String(v);
        // Try kinder
        const kinder = r.schuldner?.kinder;
        if (kinder?.length) {
          return kinder.map(k => typeof k === 'string' ? k : (k as { wert?: string }).wert || '').filter(Boolean).join(', ');
        }
        return null;
      },
      hint: 'Unterhaltspflichten',
    },
    // --- Aussonderung ---
    {
      patterns: [/aussonderung.*gesamt|gesamt.*aussonderung/i],
      extract: (r) => {
        const ef = r.forderungen?.einzelforderungen?.filter(f =>
          f.sicherheit?.art === 'eigentumsvorbehalt'
        );
        if (!ef?.length) return 'keine';
        const sum = ef.reduce((s, f) => s + (sn(f.sicherheit?.geschaetzter_wert) || 0), 0);
        return sum > 0 ? formatEUR(sum) : 'keine';
      },
      hint: 'Aussonderungsansprueche',
    },
    // --- Absonderung ---
    {
      patterns: [/absonderung.*gesamt|gesamt.*absonderung/i],
      extract: (r) => {
        const ef = r.forderungen?.einzelforderungen?.filter(f =>
          f.sicherheit && f.sicherheit.art !== 'eigentumsvorbehalt'
        );
        if (!ef?.length) return 'keine';
        const sum = ef.reduce((s, f) => s + (sn(f.sicherheit?.geschaetzter_wert) || 0), 0);
        return sum > 0 ? formatEUR(sum) : 'keine';
      },
      hint: 'Absonderungsansprueche',
    },
    // --- Anfechtungspotenzial ---
    {
      patterns: [/anfechtung.*potenzial|potenzial.*anfechtung|insolvenzspezifisch.*anspr/i],
      extract: (r) => {
        const v = sn(r.anfechtung?.gesamtpotenzial);
        return v != null ? formatEUR(v) : null;
      },
      hint: 'Anfechtungspotenzial',
    },
    // --- Kinder ---
    {
      patterns: [/kinder.*geburtsdatum|zusammenleben/i],
      extract: (r) => {
        const kinder = r.schuldner?.kinder;
        if (!kinder?.length) return 'keine';
        return kinder.map(k => typeof k === 'string' ? k : (k as { wert?: string }).wert || '').filter(Boolean).join('; ');
      },
      hint: 'Kinder',
    },
    // --- Branche ---
    {
      patterns: [/branche|gesch.{0,5}ftst.{0,5}tigkeit|unternehmensgegenstand|Geschäftszweig/i],
      extract: (r) => {
        // Prefer direct geschaeftszweig field
        const gz = r.schuldner?.geschaeftszweig?.wert;
        if (gz) return String(gz);
        // Fallback to unternehmensgegenstand
        const ug = r.schuldner?.unternehmensgegenstand?.wert;
        if (ug) return String(ug);
        return null;
      },
      hint: 'Branche',
    },
    // --- Finanzstatus / Bilanz ---
    {
      patterns: [/bilanz|finanzstatus|stichtagsbezogen/i],
      extract: (r) => {
        const pos = r.aktiva?.positionen;
        if (!pos?.length) return null;
        const summe = sn(r.aktiva?.summe_aktiva);
        const mk = sn(r.aktiva?.massekosten_schaetzung);
        const lines = pos.map(p => {
          const w = sn(p.geschaetzter_wert);
          return `${sv(p.beschreibung) || p.kategorie}: ${w != null ? formatEUR(w) : 'k.A.'}`;
        });
        if (summe != null) lines.push(`Summe Aktiva: ${formatEUR(summe)}`);
        if (mk != null) lines.push(`Massekosten: ${formatEUR(mk)}`);
        return lines.join('\n');
      },
      hint: 'Finanzstatus',
    },
  ];
}

/** Check if template text after the slot already contains "EUR" */
function contextHasEurSuffix(slot: SlotInfo): boolean {
  // Check if context has "EUR" right after the slot marker
  const slotMarker = `[[${slot.id}]]`;
  const idx = slot.context.indexOf(slotMarker);
  if (idx < 0) return false;
  const after = slot.context.slice(idx + slotMarker.length, idx + slotMarker.length + 10).trim();
  return /^EUR\b/i.test(after);
}

/** Format EUR value, omitting "EUR" suffix if template already has it */
function fmtEUR(value: unknown, slot: SlotInfo): string {
  return formatEUR(value, !contextHasEurSuffix(slot));
}

/** Pre-fill slots deterministically from extraction data */
/** Unescape XML entities that may appear in extraction data or AI output */
function unescapeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"');
}

function preFillSlots(
  slots: SlotInfo[],
  result: ExtractionResult
): Map<string, { value: string; hint: string }> {
  const matchers = buildPreFillMatchers();
  const filled = new Map<string, { value: string; hint: string }>();

  // Phase 1: Pattern-based matching
  for (const slot of slots) {
    const ctx = (slot.context + ' ' + slot.original).toLowerCase();
    for (const matcher of matchers) {
      if (matcher.patterns.some(p => p.test(ctx))) {
        const value = matcher.extract(result);
        if (value) {
          // Strip "EUR" suffix if template already has it
          let cleanValue = contextHasEurSuffix(slot) ? value.replace(/\s*EUR$/i, '') : value;
          cleanValue = unescapeXmlEntities(cleanValue);
          // Strip [...] brackets (but preserve [TODO:...])
          cleanValue = cleanValue.replace(/\[(?!TODO:)([^\]]*)\]/g, '$1');
          filled.set(slot.id, { value: cleanValue, hint: matcher.hint });
          break;
        }
      }
    }
  }

  // Phase 2: Sequential filling for positional slots (aktiva rows, EUR amounts)
  fillSequentialSlots(slots, result, filled);

  // Phase 3: Table slots
  fillTableSlots(slots, result, filled);

  // Phase 4: Calculated financial slots
  fillCalculatedSlots(slots, result, filled);

  return filled;
}

/** Fill positional slots that appear in sequence (e.g. multiple "Betrag EUR" slots) */
function fillSequentialSlots(
  slots: SlotInfo[],
  result: ExtractionResult,
  filled: Map<string, { value: string; hint: string }>
): void {
  const positionen = result.aktiva?.positionen ?? [];
  if (positionen.length === 0) return;

  // Find consecutive "Betrag...EUR" slots that aren't filled yet
  const eurSlots = slots.filter(s =>
    !filled.has(s.id) &&
    /betrag.*eur|eur.*betrag|\[\[SLOT_\d+\]\]\s*EUR/i.test(s.context) &&
    !/verfahrenskosten|masse.*position|passiva/i.test(s.context)
  );

  // Assign aktiva values in order
  let posIdx = 0;
  for (const slot of eurSlots) {
    if (posIdx >= positionen.length) break;
    const wert = sn(positionen[posIdx].geschaetzter_wert);
    if (wert != null) {
      filled.set(slot.id, {
        value: formatEUR(wert),
        hint: String(positionen[posIdx].beschreibung?.wert || positionen[posIdx].kategorie),
      });
    }
    posIdx++;
  }

  // Find "Aktiva-Position Beschreibung" slots
  const aktivaDescSlots = slots.filter(s =>
    !filled.has(s.id) &&
    /aktiva.{0,5}position.*beschreibung|beschreibung.*betrag/i.test(s.context)
  );

  posIdx = 0;
  for (const slot of aktivaDescSlots) {
    if (posIdx >= positionen.length) break;
    const p = positionen[posIdx];
    const wert = sn(p.geschaetzter_wert);
    filled.set(slot.id, {
      value: `${sv(p.beschreibung) || p.kategorie}: ${wert != null ? formatEUR(wert) : 'k.A.'}`,
      hint: `Aktivum ${posIdx + 1}`,
    });
    posIdx++;
  }
}

/** Fill table-type slots with formatted lists */
function fillTableSlots(
  slots: SlotInfo[],
  result: ExtractionResult,
  filled: Map<string, { value: string; hint: string }>
): void {
  for (const slot of slots) {
    if (filled.has(slot.id)) continue;
    const ctx = (slot.context + ' ' + slot.original).toLowerCase();

    // Insolvenzforderungen table
    if (/tabelle.*insolvenzforderung|angemeldete.*forderung.*tabelle/i.test(ctx)) {
      const ef = result.forderungen?.einzelforderungen?.filter(f => f.rang === '§38 Insolvenzforderung');
      if (ef?.length) {
        const lines = ef.map(f => {
          const b = sn(f.betrag);
          return `${sv(f.glaeubiger) || 'k.A.'} (${f.art}): ${b != null ? formatEUR(b) : 'k.A.'}`;
        });
        const total = ef.reduce((s, f) => s + (sn(f.betrag) || 0), 0);
        lines.push(`Gesamt: ${formatEUR(total)}`);
        filled.set(slot.id, { value: lines.join('\n'), hint: 'Insolvenzforderungen' });
      }
    }

    // Masseforderungen table
    if (/tabelle.*masseforderung|masse.*55/i.test(ctx)) {
      const ef = result.forderungen?.einzelforderungen?.filter(f => f.rang === 'Masseforderung §55');
      if (ef?.length) {
        const lines = ef.map(f => {
          const b = sn(f.betrag);
          return `${sv(f.glaeubiger) || 'k.A.'}: ${b != null ? formatEUR(b) : 'k.A.'}`;
        });
        filled.set(slot.id, { value: lines.join('\n'), hint: 'Masseforderungen' });
      } else {
        filled.set(slot.id, { value: 'Masseforderungen liegen derzeit nicht vor.', hint: 'Masseforderungen' });
      }
    }

    // Absonderung table
    if (/tabelle.*absonderung|absonderung.*gl.{0,5}ubiger.*sicherheit/i.test(ctx)) {
      const ef = result.forderungen?.einzelforderungen?.filter(f => f.sicherheit && f.sicherheit.absonderungsberechtigt);
      if (ef?.length) {
        const lines = ef.map(f => {
          const b = sn(f.betrag);
          return `${sv(f.glaeubiger) || 'k.A.'} — ${f.sicherheit!.art}: ${b != null ? formatEUR(b) : 'k.A.'}`;
        });
        filled.set(slot.id, { value: lines.join('\n'), hint: 'Absonderungsrechte' });
      } else {
        filled.set(slot.id, { value: 'Absonderungsrechte bestehen nach derzeitigem Erkenntnisstand nicht.', hint: 'Absonderungsrechte' });
      }
    }

    // Anfechtung overview
    if (/anfechtung.*129|129.*anfechtung|anfechtungsanspr/i.test(ctx)) {
      const vorgaenge = result.anfechtung?.vorgaenge;
      if (vorgaenge?.length) {
        const lines = vorgaenge.map(v => {
          const b = sn(v.betrag);
          return `${sv(v.beschreibung) || 'k.A.'} (${v.grundlage}, ${v.risiko}): ${b != null ? formatEUR(b) : 'k.A.'}`;
        });
        filled.set(slot.id, { value: lines.join('\n'), hint: 'Anfechtbare Vorgaenge' });
      }
    }

    // Fortführungsaussichten / Sanierung
    if (/fortf.{0,5}hrung.*aussicht|beurteilung.*fortf|sanierung.*perspektive/i.test(ctx)) {
      const ia = result.aktiva?.insolvenzanalyse;
      if (ia?.gesamtbewertung) {
        filled.set(slot.id, { value: ia.gesamtbewertung, hint: 'Fortfuehrungsaussichten' });
      }
    }
  }
}

/** Fill slots with calculated financial values */
function fillCalculatedSlots(
  slots: SlotInfo[],
  result: ExtractionResult,
  filled: Map<string, { value: string; hint: string }>
): void {
  const summeAktiva = sn(result.aktiva?.summe_aktiva);
  const massekosten = sn(result.aktiva?.massekosten_schaetzung);
  const gesamtforderungen = sn(result.forderungen?.gesamtforderungen);
  const anfechtung = sn(result.anfechtung?.gesamtpotenzial);

  // Compute summe from positionen if not set
  const positionenSumme = (result.aktiva?.positionen ?? [])
    .reduce((s, p) => s + (sn(p.geschaetzter_wert) || 0), 0);
  const computedSumme = summeAktiva ?? (positionenSumme > 0 ? positionenSumme : null);

  // Compute freie Masse
  const freieMasse = computedSumme != null && massekosten != null
    ? computedSumme - massekosten : null;

  for (const slot of slots) {
    if (filled.has(slot.id)) continue;
    const ctx = (slot.context + ' ' + slot.original).toLowerCase();

    // Freies Vermögen / Insolvenzmasse
    if (/freies.*verm.{0,5}gen.*eur|insolvenzmasse.*eur|masse.*bestand.*eur/i.test(ctx)) {
      if (computedSumme != null) {
        filled.set(slot.id, { value: formatEUR(computedSumme), hint: 'Aktiva/Insolvenzmasse' });
      }
    }

    // Insolvenzspezifische Ansprüche / Anfechtungspotenzial EUR
    if (/insolvenzspezifisch.*anspr.*eur|realisierbar.*eur|mindestens.*eur.*realisier/i.test(ctx)) {
      if (anfechtung != null) {
        filled.set(slot.id, { value: formatEUR(anfechtung), hint: 'Anfechtungspotenzial' });
      } else if (computedSumme != null) {
        filled.set(slot.id, { value: formatEUR(computedSumme), hint: 'Realisierbare Masse' });
      }
    }

    // Verfahrenskosten gesamt
    if (/verfahrenskosten.*von.*eur/i.test(ctx)) {
      if (massekosten != null) {
        filled.set(slot.id, { value: formatEUR(massekosten), hint: 'Verfahrenskosten' });
      }
    }

    // Passiva / Verbindlichkeiten Betrag
    if (/passiva.*eur|verbindlichkeit.*eur/i.test(ctx)) {
      if (gesamtforderungen != null) {
        filled.set(slot.id, { value: formatEUR(gesamtforderungen), hint: 'Verbindlichkeiten' });
      }
    }

    // Forderungen aus Lieferung und Leistung
    if (/forderungen.*lieferung.*leistung/i.test(ctx) && !/stand/i.test(slot.original)) {
      const pos = result.aktiva?.positionen?.find(p => p.kategorie === 'forderungen_schuldner');
      if (pos) {
        const wert = sn(pos.geschaetzter_wert);
        if (wert != null) filled.set(slot.id, { value: formatEUR(wert), hint: 'Forderungen LuL' });
      }
    }

    // Bankguthaben
    if (/bankguthaben|kontostand/i.test(ctx) && !/stand/i.test(slot.original)) {
      const pos = result.aktiva?.positionen?.find(p => p.kategorie === 'bankguthaben');
      if (pos) {
        const wert = sn(pos.geschaetzter_wert);
        if (wert != null) filled.set(slot.id, { value: formatEUR(wert), hint: 'Bankguthaben' });
      }
    }

    // Eröffnungsvoraussetzungen / Zahlungsunfähigkeit Prüfung
    if (/er.{0,3}ffnungsvoraussetzung|zahlungsunf.{0,5}higkeit.*masse/i.test(ctx)) {
      const ia = result.aktiva?.insolvenzanalyse;
      if (ia) {
        const parts: string[] = [];
        if (ia.zahlungsunfaehigkeit_17?.status === 'ja') {
          parts.push(`Zahlungsunfähigkeit gem. § 17 InsO liegt vor: ${ia.zahlungsunfaehigkeit_17.begruendung}`);
        }
        if (ia.massekostendeckung_26?.status === 'ja') {
          parts.push(`Massedeckung gem. § 26 InsO ist gewährleistet: ${ia.massekostendeckung_26.begruendung}`);
        }
        if (ia.ueberschuldung_19) {
          const ue = ia.ueberschuldung_19;
          parts.push(`Überschuldung gem. § 19 InsO: ${ue.status === 'ja' ? 'liegt vor' : ue.status === 'offen' ? 'noch offen' : 'liegt nicht vor'}. ${ue.begruendung}`);
        }
        if (parts.length) {
          filled.set(slot.id, { value: parts.join(' '), hint: 'Eroeffnungsvoraussetzungen' });
        }
      }
    }
  }
}

// --- Flatten ExtractionResult ---

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
  walk(result.gutachterbestellung, 'gutachterbestellung');
  walk(result.ermittlungsergebnisse, 'ermittlungsergebnisse');
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
    flat['forderungen.anzahl_glaeubiger'] = result.forderungen.einzelforderungen.length;
  }

  if (result.forderungen?.betroffene_arbeitnehmer?.length) {
    flat['forderungen.arbeitnehmer'] = result.forderungen.betroffene_arbeitnehmer;
  }

  if (result.aktiva) {
    flat['aktiva.summe_aktiva'] = result.aktiva.summe_aktiva?.wert;
    flat['aktiva.massekosten_schaetzung'] = result.aktiva.massekosten_schaetzung?.wert;
    flat['aktiva.positionen'] = result.aktiva.positionen.map(p => ({
      beschreibung: p.beschreibung?.wert,
      geschaetzter_wert: p.geschaetzter_wert?.wert,
      kategorie: p.kategorie,
    }));
    if (result.aktiva.insolvenzanalyse) {
      flat['aktiva.insolvenzanalyse'] = result.aktiva.insolvenzanalyse;
    }
  }

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

// --- Slot classification ---

function isNarrativeSlot(slot: SlotInfo): boolean {
  const text = (slot.context + ' ' + slot.original).toLowerCase();
  return /begr.{0,3}ndung|darstellung|feststellung|ausf.{0,3}hrung|bewertung|ergebnis|zusammenfassung|schlussfolgerung|empfehlung|einsch.{0,3}tzung|analyse|pr.{0,3}fung|w.{0,3}rdigung|stellungnahme|liquidation.*fortf|fortf.*liquidation|investoren|sanierung|finanzstatus|liquidit.{0,3}tsplan|er.{0,3}ffnungsvoraussetzung|kommunikation.*stakeholder|ma.{0,3}nahmen.*liquidit/i.test(text);
}

// --- Prompts ---

const FACTUAL_PROMPT = `Du bist ein spezialisierter KI-Assistent fuer die Insolvenzverwalter-Kanzlei Prof. Dr. Dr. Thomas B. Schmidt. Du erhaeltst Platzhalter (Slots) aus einer Gutachten-Vorlage mit Kontext und extrahierte Daten aus der Gerichtsakte.

WICHTIG:
- Fuelle JEDEN Slot, fuer den Daten vorhanden sind. Sei NICHT uebervorsichtig.
- Suche AKTIV in den Daten nach passenden Werten. Wenn der Slot "Arbeitnehmer" erwaehnt, suche in forderungen.arbeitnehmer, ermittlungsergebnisse, zusammenfassung etc.
- Wenn der Slot eine Tabelle oder Liste erwartet (Aktiva, Passiva, Forderungen), erstelle eine formatierte Aufstellung aus den Daten.
- Betraege IMMER im Format 1.234,56 EUR. ABER: Wenn der Kontext nach dem Slot bereits "EUR" enthaelt (z.B. "[[SLOT_xxx]] EUR"), dann NUR die Zahl ohne "EUR" (z.B. "1.234,56").
- Daten IMMER als TT.MM.JJJJ.
- NUR wenn wirklich KEINE passenden Daten existieren: "[TODO: ...]" mit Beschreibung was fehlt.
- Redaktionelle Anweisungen ([wenn...], [ggf....]): "[TODO: ...]"
- "xxxx"-Platzhalter ohne Daten: "[TODO: Datum/Wert eintragen]"
- "hint" ist IMMER 3-8 Woerter: was gehoert in dieses Feld.

BEISPIELE AUS ECHTEN TBS-GUTACHTEN:

Slot "Statistische Angaben": Erstelle eine tabellarische Aufstellung:
→ "Firma: freiraum 3 Moselresidenz Traben-Trarbach GmbH\\nRechtsform: Gesellschaft mit beschränkter Haftung (GmbH)\\nSatzungsgemäßer Sitz: Kaiser-Friedrich-Ring 30-32, 66740 Saarlouis\\nVerwaltungssitz: Bahnhofstr. 16-18, 67742 Lauterecken\\nHandelsregister: AG Saarbrücken, HRB 108863\\nInsolvenzforderungen: 6.174.581,87 EUR\\n  davon gesichert: 4.685.817,03 EUR\\n  davon nachrangig: 1.300.000,00 EUR\\nAntragstellerin: Raiffeisenbank Mehring-Leiwen eG\\nAntragsgrund: Zahlungsunfähigkeit (§ 17 InsO)\\nInternationaler Bezug: Nein\\nEigenverwaltung: Nicht beantragt\\nArbeitnehmer: 0\\nBetriebsrat: Nein"

Slot "Gesellschaftsrechtliche Angaben": Tabelle mit Gesellschaftern:
→ "Stammkapital: 25.000,00 EUR\\n\\nGesellschafter:\\n1. DL Projektentwicklung mbH, Im Webersgarten 25, 54484 Maring-Noviand — 10,5 %\\n2. KS Holding GmbH, Kaiser-Friedrich-Ring 30-32, 66740 Saarlouis — 39,5 %\\n3. Koch-Company-Group S.A., 8 Am Scheerleck, L-6868 Wecker — 39,5 %\\n4. IPK Investitions-, Projekt- und Beteiligungsgesellschaft UG, Schulstraße 37, 67742 Lauterecken — 10,5 %\\n\\nGeschäftsführer: Sven Heinrich Kehrein-Seckler, geb. 22.01.1981, einzelvertretungsberechtigt, befreit von § 181 BGB\\nProokurist: Sascha Vogel, geb. 18.03.1985, Einzelprokura"

Slot "Steuerrechtliche Angaben":
→ "Finanzamt: Finanzamt Wittlich\\nSteuer-Nr.: 43/655/16073\\nUSt.-ID: DE361807026\\nWirtschaftsjahr: Kalenderjahr\\nUSt-Versteuerung: Soll-Versteuerung\\nSteuerliche Organschaft: Nein\\nLetzter Jahresabschluss: Wirtschaftsjahr 2024"

Slot "Sonstige Angaben" (natuerliche Person):
→ "Geburtsdatum: 17.12.1982\\nUnterhaltspflichten: Kinder: Evelin Geldt, geb. 17.12.2009, 56727 Mayen — Barunterhalt 303,00 EUR monatlich\\nEhegatten/Lebenspartner: ledig\\nTelefon: 06545 9121110\\nE-Mail: info@geldt-cnc.de\\nSozialversicherungsträger: AOK, UKV Union Krankenversicherung AG\\nSteuerberater: Steuerberater Kneip – Daute, Friedrich-Back-Straße 21, 56288 Kastellaun"

Slot "Anzahl Arbeitnehmer": Suche aktiv → "44"
Slot "Lohnrueckstaende": Suche Betraege → "271.000,00 EUR (seit Oktober 2025)"
Slot "Verbindlichkeiten": Nutze forderungen.gesamtforderungen → "580.069,42 EUR"
Slot "Steuerberater": Suche in ermittlungsergebnisse → "FSP Steuerberatung GmbH & Co. KG"

Antworte AUSSCHLIESSLICH mit validem JSON:
{"SLOT_001": {"value": "18.12.2025", "hint": "Datum Beschluss"}, ...}`;

const NARRATIVE_PROMPT = `Du bist ein erfahrener deutscher Insolvenzverwalter der Kanzlei Prof. Dr. Dr. Thomas B. Schmidt und verfasst Abschnitte fuer ein Gutachten gemaess § 5 InsO.

SCHREIBSTIL (orientiert an echten TBS-Gutachten):
- Sachlich, praezise, juristisch korrekt — keine Floskeln oder Fuellwoerter.
- "Der Unterzeichner" statt "ich" oder "wir". "Die Antragsgegnerin/Der Antragsteller" statt "Schuldner" wo moeglich.
- Aktiv formulieren: "Der Unterzeichner hat geprueft..." statt Passiv.
- Betraege: 1.234,56 EUR. Daten: TT.MM.JJJJ. Paragraphen: § 17 InsO, §§ 130, 131 InsO.
- Wenn keine Daten: "[TODO: Angaben ergaenzen — ...]"

BEISPIELE AUS ECHTEN TBS-GUTACHTEN:

Slot "Vorliegen Zahlungsunfähigkeit" (juristische Person):
→ "Die Antragsgegnerin ist zahlungsunfähig (§ 17 InsO).\\n\\nDen fälligen und ernsthaft eingeforderten Verbindlichkeiten in Höhe von 6.174.581,87 EUR stehen keine kurzfristig verfügbaren liquiden Mittel gegenüber. Der Geschäftsbetrieb ist faktisch eingestellt. Die Antragsgegnerin verfügt über keinerlei Einnahmen. Es ist mit an Sicherheit grenzender Wahrscheinlichkeit ausgeschlossen, dass die Deckungslücke innerhalb der nächsten drei Wochen geschlossen wird."

Slot "Vorliegen Zahlungsunfähigkeit" (natuerliche Person):
→ "Der Antragsteller ist zahlungsunfähig (§ 17 InsO).\\n\\nDen fälligen und ernsthaft eingeforderten Verbindlichkeiten in Höhe von 326.826,15 EUR stehen liquide Mittel in Höhe eines Bankguthabens von 10.680,79 EUR gegenüber. Damit sind rund 3,27 % der fälligen und ernsthaft eingeforderten Verbindlichkeiten gedeckt. Es besteht eine Deckungslücke in Höhe von rund 96,73 %. Es ist nahezu ausgeschlossen, dass die Deckungslücke innerhalb der nächsten drei Wochen geschlossen wird."

Slot "Sanierungsaussichten":
→ "Der Geschäftsbetrieb der Antragsgegnerin ist faktisch eingestellt. In Anbetracht des Zwecks der Antragsgegnerin, als reine Projektgesellschaft die Bauträgerschaft für das Einzelbauvorhaben, In den Hupen, 56849 Traben-Trarbach, zu übernehmen, ist zukünftig auch nicht mit neuen Bauträgeraufträgen zu rechnen. Mithin besteht keine Aussicht auf Sanierung des schuldnerischen Unternehmens.\\n\\nKern des eröffneten Verfahrens wird somit die Verwertung der Immobilien sein."

Slot "Wirtschaftliche Entwicklung und Krisenursache":
→ "Unter Berücksichtigung von Aussagen des Antragstellers basiert die Insolvenz nach ersten Einschätzungen des Unterzeichners einerseits auf einem akuten Rückgang betrieblicher Umsätze. Ausgelöst wurde dieser Umsatzrückgang durch einen spätestens im Geschäftsjahr 2024 eingetretenen Auftragsmangel, der auf eine äußerst konjunkturschwache Periode für das Unternehmen zurückzuführen ist."

Slot "Anfechtungsansprüche":
→ "Der Unterzeichner hat Insolvenzanfechtungsansprüche geprüft und ist zu folgendem Ergebnis gelangt:\\n\\nAnfechtungsansprüche sind bisher nicht festgestellt. Insoweit bleibt die abschließende Bezifferung der Insolvenzanfechtungsansprüche dem eröffneten Insolvenzverfahren vorbehalten. Der Unterzeichner setzt für diesen Posten daher vorerst keinen Wert an."

Slot "Kostenbeitraege § 171":
→ "Aufgrund der festgestellten Absonderungsrechte am beweglichen Anlagevermögen zu Liquidationswerten in Höhe von 87.492,00 EUR ist noch mit Feststellungskostenbeiträgen gem. § 171 InsO in Höhe von 9 %, also\\n\\n7.874,28 EUR\\n\\nzu rechnen."

Slot "Verfahrenskostendeckung":
→ "Es ist derzeit freies Vermögen zu Liquidationswerten in Höhe von 19.727,45 EUR vorhanden. Es lassen sich insolvenzspezifische Ansprüche in Höhe von mindestens 7.874,28 EUR realisieren. Ausgehend von einem Massebestand in Höhe von 27.601,73 EUR würden sich die Verfahrenskosten wie folgt berechnen:\\n\\nVergütung vorläufiges Insolvenzverfahren: 6.569,20 EUR\\nVergütung eröffnetes Verfahren: 15.109,18 EUR\\nGerichtskosten: 4.779,50 EUR\\nGesamt: 26.457,88 EUR\\n\\nDie Deckung der Verfahrenskosten ist damit aller Voraussicht nach gewährleistet."

Slot "Ergebnis und Empfehlung":
→ "1. Die Antragsgegnerin ist zahlungsunfähig (§ 17 InsO) und überschuldet (§ 19 InsO).\\n\\n2. Eine die Verfahrenskosten deckende Masse (§ 54 InsO) wird im eröffneten Verfahren voraussichtlich vorhanden sein. Ungeachtet dessen hat die Antragstellerin ihre Bereitschaft zur Übernahme der Verfahrenskosten erklärt.\\n\\n3. Sicherungsmaßnahmen waren nicht erforderlich.\\n\\nIch empfehle daher,\\ndas Insolvenzverfahren zu eröffnen."

Antworte AUSSCHLIESSLICH mit validem JSON:
{"SLOT_001": {"value": "Die Antragsgegnerin ist...", "hint": "Begruendung Insolvenzgrund"}, ...}`;

// --- Fill Slots ---

export async function fillSlots(
  slots: SlotInfo[],
  result: ExtractionResult
): Promise<GutachtenSlot[]> {
  if (slots.length === 0) return [];

  // Step 1: Deterministic pre-fill from extraction data
  const preFilled = preFillSlots(slots, result);
  logger.info('Pre-fill completed', { preFilled: preFilled.size, total: slots.length });

  // Step 2: Send remaining slots to Claude
  const remainingSlots = slots.filter(s => !preFilled.has(s.id));
  const flatData = flattenResult(result);

  const factualSlots = remainingSlots.filter(s => !isNarrativeSlot(s));
  const narrativeSlots = remainingSlots.filter(s => isNarrativeSlot(s));

  logger.info('Slot classification', {
    total: slots.length,
    preFilled: preFilled.size,
    factual: factualSlots.length,
    narrative: narrativeSlots.length,
  });

  // Split large batches into chunks of max 40 slots to avoid output truncation
  const BATCH_SIZE = 40;
  const factualChunks: SlotInfo[][] = [];
  for (let i = 0; i < factualSlots.length; i += BATCH_SIZE) {
    factualChunks.push(factualSlots.slice(i, i + BATCH_SIZE));
  }

  const allPromises: Promise<Map<string, { value: string; hint: string }>>[] = [];

  // Factual chunks in parallel
  for (const chunk of factualChunks) {
    allPromises.push(
      fillSlotBatch(chunk, flatData, FACTUAL_PROMPT, config.UTILITY_MODEL || 'claude-haiku-4-5-20251001')
    );
  }

  // Narrative batch
  if (narrativeSlots.length > 0) {
    allPromises.push(
      fillSlotBatch(narrativeSlots, flatData, NARRATIVE_PROMPT, config.EXTRACTION_MODEL || 'claude-sonnet-4-6')
    );
  }

  const batchResults = await Promise.all(allPromises);
  const [factualResults, narrativeResults] = [
    new Map(batchResults.slice(0, factualChunks.length).flatMap(m => [...m])),
    batchResults.length > factualChunks.length ? batchResults[batchResults.length - 1] : new Map<string, { value: string; hint: string }>(),
  ];

  // Merge: pre-filled > factual > narrative
  const allResults = new Map([...factualResults, ...narrativeResults, ...preFilled]);

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
        max_tokens: 16384,
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
      let value = entry && typeof entry === 'object' ? (entry.value ?? '') : String(entry ?? '');
      const hint = entry && typeof entry === 'object' ? (entry.hint ?? '') : '';
      // Strip ALL [...] brackets from values — AI wraps values in brackets
      // e.g. "[5] Arbeitnehmer" → "5 Arbeitnehmer", "[7.000 EUR]" → "7.000 EUR"
      // But preserve [TODO:...] markers
      value = value.replace(/\[(?!TODO:)([^\]]*)\]/g, '$1');
      // Unescape XML entities that the AI may have included literally
      value = unescapeXmlEntities(value);
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
