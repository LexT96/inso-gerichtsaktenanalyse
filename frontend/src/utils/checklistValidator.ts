import type { ExtractionResult, Standardanschreiben } from '../types/extraction';

interface ChecklistRule {
  typ: string;
  requiredFields: string[];
  requiredFieldsOr?: string[][];
}

/**
 * Static checklist rules derived from standardschreiben/checklisten.json.
 * Only the fields needed for status computation.
 */
const CHECKLIST_RULES: ChecklistRule[] = [
  {
    typ: 'Bankenauskunft',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Bausparkassen-Anfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Steuerberater-Kontakt',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname'],
      ['schuldner.firma'],
    ],
  },
  {
    typ: 'Strafakte-Akteneinsicht',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'KFZ-Halteranfrage Zulassungsstelle',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.geburtsdatum', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.handelsregisternummer', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Gewerbeauskunft',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.betriebsstaette_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Finanzamt-Anfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'KFZ-Halteranfrage KBA',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.geburtsdatum', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.handelsregisternummer', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Versicherungsanfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
  {
    typ: 'Gerichtsvollzieher-Anfrage',
    requiredFields: ['verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht'],
    requiredFieldsOr: [
      ['schuldner.name', 'schuldner.vorname', 'schuldner.aktuelle_adresse'],
      ['schuldner.firma', 'schuldner.betriebsstaette_adresse'],
    ],
  },
];

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

function hasValue(result: ExtractionResult, fieldPath: string): boolean {
  const v = getFieldValue(result, fieldPath);
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return !Number.isNaN(v);
  return true;
}

function isRuleSatisfied(result: ExtractionResult, rule: ChecklistRule): boolean {
  for (const field of rule.requiredFields) {
    if (!hasValue(result, field)) return false;
  }
  if (rule.requiredFieldsOr && rule.requiredFieldsOr.length > 0) {
    return rule.requiredFieldsOr.some(group =>
      group.every(field => hasValue(result, field))
    );
  }
  return true;
}

/**
 * Recomputes letter statuses based on current ExtractionResult field values.
 * Letters with status 'entfaellt' are not changed.
 */
export function recomputeLetterStatuses(result: ExtractionResult): Standardanschreiben[] {
  const letters = result.standardanschreiben || [];

  return letters.map(letter => {
    if (letter.status === 'entfaellt') return letter;

    const rule = CHECKLIST_RULES.find(r => r.typ === letter.typ);
    if (!rule) return letter;

    const satisfied = isRuleSatisfied(result, rule);

    if (satisfied && letter.status === 'fehlt') {
      return { ...letter, status: 'bereit' as const, fehlende_daten: [] };
    }
    if (!satisfied && letter.status === 'bereit') {
      return { ...letter, status: 'fehlt' as const };
    }

    return letter;
  });
}
