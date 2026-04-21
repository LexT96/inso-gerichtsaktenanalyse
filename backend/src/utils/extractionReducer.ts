/**
 * Extraction Reducer
 *
 * Collects ExtractionCandidate arrays from multiple field packs, groups them
 * by fieldPath, resolves conflicts using authority-based ranking, and builds
 * a partial ExtractionResult from the winning candidates.
 *
 * Array fields (einzelforderungen, positionen, vorgaenge) are NOT handled here
 * — they come from Stage 2b focused passes and are merged separately downstream.
 */

import type {
  ExtractionCandidate,
  ExtractionResult,
  SourcedValue,
} from '../types/extraction';
import { resolveCandidate } from './fieldAuthority';
import { logger } from './logger';

// ─── Empty Result Factory ────────────────────────────────────────────────────

/** Creates a SourcedValue<T> with null wert and empty quelle. */
function sv<T = string>(): SourcedValue<T> {
  return { wert: null as unknown as T | null, quelle: '' };
}

/** Builds a fully initialized empty ExtractionResult.
 *
 *  Every SourcedValue field is `{ wert: null, quelle: '' }`.
 *  Every array field is `[]`.
 *  This satisfies the ExtractionResult interface so downstream code can
 *  safely access any path without null-checks on the containing object.
 */
function createEmptyResult(): ExtractionResult {
  return {
    verfahrensdaten: {
      aktenzeichen: sv(),
      gericht: sv(),
      richter: sv(),
      antragsdatum: sv(),
      beschlussdatum: sv(),
      antragsart: sv(),
      eroeffnungsgrund: sv(),
      zustellungsdatum_schuldner: sv(),
      verfahrensstadium: sv(),
      verfahrensart: sv(),
      internationaler_bezug: sv<boolean>(),
      eigenverwaltung: sv<boolean>(),
    },
    schuldner: {
      name: sv(),
      vorname: sv(),
      geburtsdatum: sv(),
      geburtsort: sv(),
      geburtsland: sv(),
      staatsangehoerigkeit: sv(),
      familienstand: sv(),
      geschlecht: sv(),
      aktuelle_adresse: sv(),
      fruehere_adressen: [],
      firma: sv(),
      rechtsform: sv(),
      betriebsstaette_adresse: sv(),
      handelsregisternummer: sv(),
      kinder: [],
      telefon: sv(),
      mobiltelefon: sv(),
      email: sv(),
      satzungssitz: sv(),
      verwaltungssitz: sv(),
      unternehmensgegenstand: sv(),
      geschaeftszweig: sv(),
      stammkapital: sv(),
      gesellschafter: [],
      geschaeftsfuehrer: sv(),
      prokurist: sv(),
      gruendungsdatum: sv(),
      hr_eintragung_datum: sv(),
      groessenklasse_hgb: sv(),
      dundo_versicherung: sv(),
      arbeitnehmer_anzahl: sv<number>(),
      betriebsrat: sv<boolean>(),
      finanzamt: sv(),
      steuernummer: sv(),
      ust_id: sv(),
      wirtschaftsjahr: sv(),
      ust_versteuerung: sv(),
      steuerliche_organschaft: sv<boolean>(),
      letzter_jahresabschluss: sv(),
      sozialversicherungstraeger: sv(),
      steuerberater: sv(),
      bankverbindungen: sv(),
      insolvenzsonderkonto: sv(),
    },
    antragsteller: {
      name: sv(),
      adresse: sv(),
      ansprechpartner: sv(),
      telefon: sv(),
      fax: sv(),
      email: sv(),
      betriebsnummer: sv(),
      bankverbindung_iban: sv(),
      bankverbindung_bic: sv(),
    },
    forderungen: {
      einzelforderungen: [],
      gesamtforderungen: sv<number>(),
      gesicherte_forderungen: sv<number>(),
      ungesicherte_forderungen: sv<number>(),
      hauptforderung_beitraege: sv<number>(),
      saeumniszuschlaege: sv<number>(),
      mahngebuehren: sv<number>(),
      vollstreckungskosten: sv<number>(),
      antragskosten: sv<number>(),
      gesamtforderung: sv<number>(),
      zeitraum_von: sv(),
      zeitraum_bis: sv(),
      laufende_monatliche_beitraege: sv<number>(),
      betroffene_arbeitnehmer: [],
    },
    gutachterbestellung: {
      gutachter_name: sv(),
      gutachter_kanzlei: sv(),
      gutachter_adresse: sv(),
      gutachter_telefon: sv(),
      gutachter_email: sv(),
      abgabefrist: sv(),
      befugnisse: [],
    },
    ermittlungsergebnisse: {
      grundbuch: {
        ergebnis: sv(),
        grundbesitz_vorhanden: sv<boolean>(),
        datum: sv(),
      },
      gerichtsvollzieher: {
        name: sv(),
        betriebsstaette_bekannt: sv<boolean>(),
        vollstreckungen: sv(),
        masse_deckend: sv<boolean>(),
        vermoegensauskunft_abgegeben: sv<boolean>(),
        haftbefehle: sv<boolean>(),
        datum: sv(),
      },
      vollstreckungsportal: {
        schuldnerverzeichnis_eintrag: sv<boolean>(),
        vermoegensverzeichnis_eintrag: sv<boolean>(),
      },
      meldeauskunft: {
        meldestatus: sv(),
        datum: sv(),
      },
    },
    fristen: [],
    standardanschreiben: [],
    fehlende_informationen: [],
    zusammenfassung: [],
    risiken_hinweise: [],
  };
}

// ─── setNestedValue ──────────────────────────────────────────────────────────

/**
 * Sets a value at a dotted path within an object, creating intermediate
 * plain objects as needed.
 *
 * Example: setNestedValue(obj, 'ermittlungsergebnisse.grundbuch.ergebnis', v)
 * is equivalent to obj.ermittlungsergebnisse.grundbuch.ergebnis = v
 *
 * Existing intermediate objects are preserved; only missing ones are created.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current[key] === null || current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Builds a partial ExtractionResult from an array of ExtractionCandidates.
 *
 * Algorithm:
 *   1. Group candidates by fieldPath.
 *   2. Resolve each group using resolveCandidate() (authority-based ranking).
 *   3. Log conflict stats.
 *   4. Start from a fully initialized empty ExtractionResult.
 *   5. Write each winning value as { wert, quelle, verifiziert: false } at
 *      its dotted path in the result.
 *
 * Array fields (einzelforderungen, positionen, vorgaenge) are NOT touched here.
 */
export function buildResultFromCandidates(candidates: ExtractionCandidate[]): ExtractionResult {
  // 1. Group by fieldPath
  const grouped = new Map<string, ExtractionCandidate[]>();
  for (const candidate of candidates) {
    const bucket = grouped.get(candidate.fieldPath);
    if (bucket) {
      bucket.push(candidate);
    } else {
      grouped.set(candidate.fieldPath, [candidate]);
    }
  }

  // 2+3. Resolve conflicts and count them
  const conflictCount = [...grouped.values()].filter(g => g.length > 1).length;
  if (conflictCount > 0) {
    logger.debug(`extractionReducer: ${conflictCount} field(s) had competing candidates — resolved via authority matrix`);
  }

  // 4. Start from empty result
  const result = createEmptyResult();
  const resultObj = result as unknown as Record<string, unknown>;

  // 5. Write winning values
  for (const [fieldPath, bucket] of grouped) {
    const winner = resolveCandidate(bucket);

    const sourcedValue: SourcedValue = {
      wert: winner.wert as string | null,
      quelle: winner.quelle,
      verifiziert: false,
    };

    setNestedValue(resultObj, fieldPath, sourcedValue);
  }

  return result;
}
