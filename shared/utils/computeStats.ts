/**
 * Single source of truth for extraction stats.
 * Used by backend (save to DB) and frontend (display).
 */

import type { ExtractionResult } from '../types/extraction';

export interface FieldDetail {
  path: string;
  label: string;
  value: string | null;
  filled: boolean;
}

export interface ExtractionStats {
  found: number;
  missing: number;
  total: number;
  lettersReady: number;
  fields: FieldDetail[];
}

// Fields only relevant for juristische Personen — skip for natürliche Person
const ENTITY_ONLY_FIELDS = new Set([
  'satzungssitz', 'verwaltungssitz', 'stammkapital', 'geschaeftsfuehrer',
  'prokurist', 'gruendungsdatum', 'hr_eintragung_datum', 'groessenklasse_hgb',
  'dundo_versicherung', 'steuerliche_organschaft',
]);

// Fields only relevant for natürliche Personen — skip for entities
const PERSON_ONLY_FIELDS = new Set([
  'geburtsort', 'geburtsland', 'staatsangehoerigkeit',
]);

// Optional fields that don't count as "missing" when empty
const OPTIONAL_FIELDS = new Set([
  'mobiltelefon', 'ust_id', 'wirtschaftsjahr', 'ust_versteuerung',
  'insolvenzsonderkonto', 'geschaeftszweig', 'unternehmensgegenstand',
  'internationaler_bezug', 'eigenverwaltung', 'verfahrensstadium', 'verfahrensart',
  'richter', 'zustellungsdatum_schuldner',
]);

const LABELS: Record<string, string> = {
  aktenzeichen: 'Aktenzeichen', gericht: 'Gericht', richter: 'Richter',
  antragsdatum: 'Antragsdatum', beschlussdatum: 'Beschlussdatum',
  antragsart: 'Antragsart', eroeffnungsgrund: 'Eröffnungsgrund',
  zustellungsdatum_schuldner: 'Zustellungsdatum',
  name: 'Name', vorname: 'Vorname', firma: 'Firma',
  rechtsform: 'Rechtsform', handelsregisternummer: 'HRB',
  aktuelle_adresse: 'Adresse', betriebsstaette_adresse: 'Betriebsstätte',
  geburtsdatum: 'Geburtsdatum', familienstand: 'Familienstand',
  geschlecht: 'Geschlecht', telefon: 'Telefon', email: 'E-Mail',
  adresse: 'Adresse', ansprechpartner: 'Ansprechpartner',
  gutachter_name: 'Gutachter', gutachter_kanzlei: 'Kanzlei',
  gutachter_adresse: 'Gutachter-Adresse', abgabefrist: 'Abgabefrist',
  gesamtforderungen: 'Gesamtforderungen', gesicherte_forderungen: 'Gesichert',
  ungesicherte_forderungen: 'Ungesichert',
  summe_aktiva: 'Summe Aktiva', massekosten_schaetzung: 'Massekosten',
  gesamtpotenzial: 'Anfechtungspotenzial',
  ergebnis: 'Ergebnis', grundbesitz_vorhanden: 'Grundbesitz',
  meldestatus: 'Meldestatus',
  steuerberater: 'Steuerberater', finanzamt: 'Finanzamt',
  sozialversicherungstraeger: 'SV-Träger', bankverbindungen: 'Bankverbindungen',
  arbeitnehmer_anzahl: 'Arbeitnehmer', betriebsrat: 'Betriebsrat',
  letzter_jahresabschluss: 'Letzter Jahresabschluss',
  steuernummer: 'Steuer-Nr.',
};

function isEntity(result: ExtractionResult): boolean {
  const rf = String(result.schuldner?.rechtsform?.wert ?? '').toLowerCase();
  return /gmbh|ug\b|ag\b|se\b|kg\b|ohg|gbr|e\.?\s?v|partg|stiftung|verein|genossenschaft|kgaa/i.test(rf)
    || rf.includes('juristische') || rf.includes('gesellschaft');
}

function isEmpty(field: { wert?: unknown } | null | undefined): boolean {
  if (!field) return true;
  const w = field.wert;
  return w === null || w === undefined || w === '';
}

/**
 * Compute extraction stats — single source of truth.
 * Counts SourcedValue fields across all sections, with entity-aware skipping.
 */
export function computeExtractionStats(result: ExtractionResult): ExtractionStats {
  let found = 0;
  let missing = 0;
  const fields: FieldDetail[] = [];
  const entity = isEntity(result);

  const countField = (key: string, value: unknown, prefix: string) => {
    if (!value || typeof value !== 'object') return;
    const v = value as { wert?: unknown };
    if (!('wert' in v)) return;

    // Skip entity-irrelevant fields
    if (!entity && ENTITY_ONLY_FIELDS.has(key)) return;
    if (entity && PERSON_ONLY_FIELDS.has(key)) return;

    const empty = isEmpty(v);

    // Skip optional fields when empty
    if (OPTIONAL_FIELDS.has(key) && empty) return;

    const path = prefix ? `${prefix}.${key}` : key;
    const wert = v.wert != null && v.wert !== '' ? String(v.wert) : null;
    const label = LABELS[key] || key;

    if (empty) {
      missing++;
    } else {
      found++;
    }
    fields.push({ path, label, value: wert, filled: !empty });
  };

  // Check if a sub-object has ANY non-empty SourcedValue field
  const hasAnyFilled = (obj: Record<string, unknown>): boolean => {
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object' && 'wert' in value) {
        const v = value as { wert?: unknown };
        if (v.wert != null && v.wert !== '') return true;
      }
    }
    return false;
  };

  const walkObj = (obj: Record<string, unknown>, prefix: string): void => {
    if (!obj) return;
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) continue; // Skip arrays (einzelforderungen, aktiva.positionen)
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if ('wert' in v) {
          countField(key, value, prefix);
        } else {
          // Skip entirely empty sub-objects (e.g. ehegatte with all null fields)
          // so they don't inflate the missing count when the model creates empty stubs
          if (!hasAnyFilled(v)) continue;
          walkObj(v, prefix ? `${prefix}.${key}` : key);
        }
      }
    }
  };

  // Count fixed sections
  walkObj(result.verfahrensdaten as unknown as Record<string, unknown>, 'verfahrensdaten');
  walkObj(result.schuldner as unknown as Record<string, unknown>, 'schuldner');
  walkObj(result.antragsteller as unknown as Record<string, unknown>, 'antragsteller');
  walkObj(result.gutachterbestellung as unknown as Record<string, unknown>, 'gutachterbestellung');
  walkObj(result.ermittlungsergebnisse as unknown as Record<string, unknown>, 'ermittlungsergebnisse');

  // Count forderungen summary fields (not individual einzelforderungen)
  if (result.forderungen) {
    const f = result.forderungen;
    for (const key of ['gesamtforderungen', 'gesicherte_forderungen', 'ungesicherte_forderungen'] as const) {
      countField(key, f[key], 'forderungen');
    }
  }

  // Count aktiva summary
  if (result.aktiva) {
    countField('summe_aktiva', result.aktiva.summe_aktiva, 'aktiva');
    countField('massekosten_schaetzung', result.aktiva.massekosten_schaetzung, 'aktiva');
  }

  // Count anfechtung summary
  if (result.anfechtung) {
    countField('gesamtpotenzial', result.anfechtung.gesamtpotenzial, 'anfechtung');
  }

  // Letters ready
  const lettersReady = (result.standardanschreiben || [])
    .filter(l => l.status === 'bereit').length;

  return { found, missing, total: found + missing, lettersReady, fields };
}
