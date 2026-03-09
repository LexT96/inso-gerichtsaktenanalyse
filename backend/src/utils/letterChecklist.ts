/**
 * Validierung der Standardanschreiben gegen die Checklisten.
 * Prüft, ob die extrahierten Daten für jeden Brieftyp ausreichen.
 */

import fs from 'fs';
import path from 'path';
import type { ExtractionResult, Standardanschreiben } from '../types/extraction';

interface ChecklistItem {
  typ: string;
  typAliases?: string[];
  empfaengerDefault: string;
  templatePdf: string | null;
  requiredFields: string[];
  requiredFieldsOr?: string[][];
  requiredFieldsHint?: string;
  fehlendeDatenBeispiele?: string[];
}

interface ChecklistConfig {
  version: string;
  anschreiben: ChecklistItem[];
}

const CHECKLIST_PATH = path.resolve(process.cwd(), 'standardschreiben/checklisten.json');

function loadChecklists(): ChecklistConfig {
  const raw = fs.readFileSync(CHECKLIST_PATH, 'utf-8');
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
 * Prüft, ob alle requiredFields gesetzt sind und mindestens eine requiredFieldsOr-Gruppe vollständig.
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
 * Verwendet die Checkliste als kanonische Liste: ein Typ pro Dokument, keine Duplikate.
 * KI-Varianten wie "Bankenauskunft (an Banken/Sparkassen)" werden dem Typ "Bankenauskunft" zugeordnet.
 */
export function validateLettersAgainstChecklists(result: ExtractionResult): ExtractionResult {
  let checklists: ChecklistConfig;
  try {
    checklists = loadChecklists();
  } catch (err) {
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

  // Pro Checklist-Typ: gematchten KI-Brief verwenden oder Default erzeugen
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

    // Widerspruch: "bereit" aber fehlende_daten nicht leer → auf "fehlt" korrigieren
    if (base.status === 'bereit' && base.fehlende_daten?.length) {
      return { ...base, status: 'fehlt' as const };
    }

    const satisfied = isChecklistSatisfied(result, checklist);

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
