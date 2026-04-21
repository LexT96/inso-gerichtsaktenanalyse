/**
 * Validierung der Standardanschreiben gegen die Checklisten.
 *
 * Beantwortet drei Fragen pro Brieftyp:
 * 1. Wird das Schreiben noch benötigt? (zielFelder → entfällt wenn alle Zielinfos vorhanden)
 * 2. Kann es mit den vorhandenen Daten erstellt werden? (requiredFields → bereit)
 * 3. Welche Daten fehlen noch? (fehlende_daten aus requiredFields)
 */

import fs from 'fs';
import path from 'path';
import type { ExtractionResult, Standardanschreiben } from '../types/extraction';

interface ChecklistItem {
  typ: string;
  typAliases?: string[];
  zweck: string;
  empfaengerDefault: string;
  entfaelltWenn?: string;
  zielFelder?: string[];
  requiredFields: string[];
  requiredFieldsOr?: string[][];
  requiredFieldsHint?: string;
}

interface ChecklistConfig {
  version: string;
  anschreiben: ChecklistItem[];
}

function findChecklistPath(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben', 'checklisten.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben', 'checklisten.json');
}

function loadChecklists(): ChecklistConfig {
  const raw = fs.readFileSync(findChecklistPath(), 'utf-8');
  return JSON.parse(raw) as ChecklistConfig;
}

/**
 * Liest den Wert eines Felds aus dem ExtractionResult.
 * Pfad z.B. "verfahrensdaten.aktenzeichen" → result.verfahrensdaten.aktenzeichen.wert
 */
function getFieldValue(result: ExtractionResult, fieldPath: string): unknown {
  const parts = fieldPath.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return undefined;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj != null && typeof obj === 'object' && 'wert' in (obj as object)) {
    return (obj as { wert: unknown }).wert;
  }
  return obj;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

function hasValue(result: ExtractionResult, fieldPath: string): boolean {
  const v = getFieldValue(result, fieldPath);
  return !isEmpty(v);
}

/**
 * Prüft ob alle Zielfelder vorhanden sind → Schreiben entfällt.
 * Nur wenn zielFelder definiert und ALLE vorhanden.
 */
function zielInfoVorhanden(result: ExtractionResult, item: ChecklistItem): boolean {
  if (!item.zielFelder || item.zielFelder.length === 0) return false;
  return item.zielFelder.every((field) => hasValue(result, field));
}

/**
 * Prüft ob alle requiredFields + mindestens eine requiredFieldsOr-Gruppe erfüllt.
 */
function isChecklistSatisfied(result: ExtractionResult, item: ChecklistItem): boolean {
  for (const field of item.requiredFields) {
    if (!hasValue(result, field)) return false;
  }
  if (item.requiredFieldsOr && item.requiredFieldsOr.length > 0) {
    const atLeastOneGroupComplete = item.requiredFieldsOr.some((group) =>
      group.every((field) => hasValue(result, field))
    );
    if (!atLeastOneGroupComplete) return false;
  }
  return true;
}

/**
 * Ermittelt die fehlenden Felder für fehlende_daten.
 */
function getMissingFields(result: ExtractionResult, item: ChecklistItem): string[] {
  const missing: string[] = [];
  for (const field of item.requiredFields) {
    if (!hasValue(result, field)) {
      missing.push(field.replace(/\./g, ' → '));
    }
  }
  if (item.requiredFieldsOr && item.requiredFieldsOr.length > 0) {
    const anyGroupComplete = item.requiredFieldsOr.some((group) =>
      group.every((field) => hasValue(result, field))
    );
    if (!anyGroupComplete) {
      const firstGroup = item.requiredFieldsOr[0];
      for (const field of firstGroup) {
        if (!hasValue(result, field)) {
          missing.push(field.replace(/\./g, ' → '));
        }
      }
    }
  }
  return missing;
}

/** Normalisiert typ für Zuordnung: "Steuerberater-Kontakt (an StB/WP)" → "Steuerberater-Kontakt" */
function normalizeTyp(typ: string): string {
  if (!typ || typeof typ !== 'string') return '';
  const beforeParen = typ.split(' (')[0].trim();
  return beforeParen || typ.trim();
}

const STATUS_PRIORITY: Record<string, number> = { bereit: 3, fehlt: 2, entfaellt: 1 };

/**
 * Validiert die standardanschreiben des Extraktionsergebnisses gegen die Checklisten.
 *
 * Dreistufige Logik:
 * 1. Entfällt: zielFelder alle vorhanden ODER AI sagt entfällt
 * 2. Bereit: alle requiredFields + mindestens eine requiredFieldsOr-Gruppe erfüllt
 * 3. Fehlt: requiredFields unvollständig → fehlende_daten auflisten
 */
export function validateLettersAgainstChecklists(result: ExtractionResult): ExtractionResult {
  let checklists: ChecklistConfig;
  try {
    checklists = loadChecklists();
  } catch {
    return result;
  }

  const letters = result.standardanschreiben || [];

  // KI-Briefe nach normalisiertem typ gruppieren, bei Duplikaten den mit höherem Status behalten
  const byNormalizedTyp = new Map<string, Standardanschreiben>();
  for (const letter of letters) {
    const key = normalizeTyp(letter.typ);
    if (!key) continue;
    const existing = byNormalizedTyp.get(key);
    const newPrio = STATUS_PRIORITY[letter.status] ?? 0;
    const existPrio = existing ? (STATUS_PRIORITY[existing.status] ?? 0) : -1;
    if (!existing || newPrio >= existPrio) {
      byNormalizedTyp.set(key, letter);
    }
  }

  function findLetterForChecklist(item: ChecklistItem): Standardanschreiben | undefined {
    const keysToTry = [item.typ, ...(item.typAliases || [])];
    for (const k of keysToTry) {
      const found = byNormalizedTyp.get(k);
      if (found) return found;
    }
    return undefined;
  }

  const validated: Standardanschreiben[] = checklists.anschreiben.map((checklist) => {
    const letter = findLetterForChecklist(checklist);
    const base: Standardanschreiben = letter
      ? {
          typ: checklist.typ,
          empfaenger: letter.empfaenger?.trim() || checklist.empfaengerDefault,
          status: letter.status,
          begruendung: letter.begruendung ?? '',
          fehlende_daten: letter.fehlende_daten ?? [],
        }
      : {
          typ: checklist.typ,
          empfaenger: checklist.empfaengerDefault,
          status: 'fehlt' as const,
          begruendung: '',
          fehlende_daten: getMissingFields(result, checklist),
        };

    // 1. Entfällt-Check: Zielinfos bereits in der Akte?
    if (zielInfoVorhanden(result, checklist)) {
      return {
        ...base,
        status: 'entfaellt' as const,
        begruendung: base.begruendung || checklist.entfaelltWenn || 'Zielinformationen bereits in der Akte vorhanden.',
        fehlende_daten: [],
      };
    }

    // AI sagte entfällt → beibehalten (AI kennt den Kontext besser als Feldprüfung)
    if (base.status === 'entfaellt') {
      return base;
    }

    // 2. Bereit/Fehlt-Check: requiredFields prüfen
    const satisfied = isChecklistSatisfied(result, checklist);

    // Widerspruch: "bereit" aber fehlende_daten nicht leer → auf "fehlt" korrigieren
    if (base.status === 'bereit' && base.fehlende_daten?.length) {
      return { ...base, status: 'fehlt' as const };
    }

    // KI sagte "bereit", Checklist sagt nicht erfüllt → auf "fehlt" korrigieren
    if (base.status === 'bereit' && !satisfied) {
      const missing = getMissingFields(result, checklist);
      return {
        ...base,
        status: 'fehlt',
        fehlende_daten: [...new Set([...(base.fehlende_daten || []), ...missing])],
      };
    }

    // KI sagte "fehlt", Checklist erfüllt, KEINE fehlende_daten → auf "bereit" korrigieren
    if (base.status === 'fehlt' && satisfied && !base.fehlende_daten?.length) {
      return { ...base, status: 'bereit' as const, fehlende_daten: [] };
    }

    // Bei "fehlt": fehlende_daten aus Checklist ergänzen, falls leer
    if (base.status === 'fehlt' && (!base.fehlende_daten || base.fehlende_daten.length === 0)) {
      const missing = getMissingFields(result, checklist);
      if (missing.length > 0) {
        return { ...base, fehlende_daten: missing };
      }
    }

    return base;
  });

  return { ...result, standardanschreiben: validated };
}

/**
 * Pure required-field check for a single letter type. Matches the frontend's
 * `recomputeLetterStatuses` semantics: ignores LLM-added narrative `fehlende_daten`
 * and only checks whether all requiredFields + at least one requiredFieldsOr group
 * are filled. Use this when gating actions (like DOCX generation) that must stay
 * in sync with what the UI shows as "bereit".
 */
export function isLetterReady(result: ExtractionResult, typ: string): boolean {
  let checklists: ChecklistConfig;
  try {
    checklists = loadChecklists();
  } catch {
    return false;
  }
  const normalized = normalizeTyp(typ);
  const item = checklists.anschreiben.find(
    (c) => c.typ === typ
      || normalizeTyp(c.typ) === normalized
      || c.typAliases?.includes(typ),
  );
  if (!item) return false;
  return isChecklistSatisfied(result, item);
}
