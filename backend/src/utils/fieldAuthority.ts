/**
 * Field Authority Matrix
 *
 * Defines which document source type is most authoritative for each field.
 * When multiple candidates exist for the same field, the one from the
 * highest-authority source wins. Ties are broken by value completeness
 * (longer string = more detail) then by original order (stable).
 *
 * Domain rules (German insolvency law):
 * - Beschluss: authoritative for case metadata set by the court
 * - PZU (Postzustellungsurkunde): authoritative for delivery dates
 * - Handelsregister: authoritative for corporate identity
 * - Meldeauskunft: authoritative for private address / registration data
 * - Insolvenzantrag / Fragebogen: authoritative for self-reported debtor data
 * - Specialist sources (grundbuch, gerichtsvollzieher, etc.): authoritative for their own results
 */

import type { ExtractionCandidate, SegmentSourceType } from '../types/extraction';

// ─── Authority Matrix ────────────────────────────────────────────────────────
//
// Keys: field path prefix (longest-match-first lookup) or exact field path.
// Values: ordered array of SegmentSourceType — index 0 = highest authority.
//
// Only fields where the natural order differs from DEFAULT_AUTHORITY need
// explicit entries. All other fields fall back to DEFAULT_AUTHORITY.

const AUTHORITY_MATRIX: Record<string, SegmentSourceType[]> = {
  // ── Court-order metadata ─────────────────────────────────────────────────
  'verfahrensdaten.aktenzeichen': ['beschluss', 'pzu', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'verfahrensdaten.gericht':      ['beschluss', 'pzu', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'verfahrensdaten.richter':      ['beschluss', 'gutachterbestellung', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.beschlussdatum': ['beschluss', 'pzu', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.antragsdatum':   ['beschluss', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'verfahrensdaten.antragsart':     ['beschluss', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.eroeffnungsgrund': ['beschluss', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.verfahrensstadium': ['beschluss', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.verfahrensart':   ['beschluss', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.internationaler_bezug': ['beschluss', 'insolvenzantrag', 'sonstiges'],
  'verfahrensdaten.eigenverwaltung': ['beschluss', 'insolvenzantrag', 'sonstiges'],

  // ── Delivery (PZU = Postzustellungsurkunde) ──────────────────────────────
  'verfahrensdaten.zustellungsdatum_schuldner': ['pzu', 'beschluss', 'insolvenzantrag', 'sonstiges'],

  // ── Corporate identity (Handelsregister is ground truth) ─────────────────
  'schuldner.firma':                ['handelsregister', 'beschluss', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.rechtsform':           ['handelsregister', 'beschluss', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.handelsregisternummer':['handelsregister', 'beschluss', 'insolvenzantrag', 'sonstiges'],
  'schuldner.satzungssitz':         ['handelsregister', 'beschluss', 'insolvenzantrag', 'sonstiges'],
  'schuldner.verwaltungssitz':      ['handelsregister', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.geschaeftsfuehrer':    ['handelsregister', 'insolvenzantrag', 'fragebogen', 'beschluss', 'sonstiges'],
  'schuldner.gesellschafter':       ['handelsregister', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.stammkapital':         ['handelsregister', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.prokurist':            ['handelsregister', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.gruendungsdatum':      ['handelsregister', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.hr_eintragung_datum':  ['handelsregister', 'insolvenzantrag', 'sonstiges'],
  'schuldner.unternehmensgegenstand': ['handelsregister', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.groessenklasse_hgb':   ['handelsregister', 'insolvenzantrag', 'sonstiges'],

  // ── Private address & registration (Meldeauskunft is ground truth) ────────
  'schuldner.aktuelle_adresse':     ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'beschluss', 'sonstiges'],
  'schuldner.geburtsdatum':         ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'beschluss', 'sonstiges'],
  'schuldner.geburtsort':           ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.geburtsland':          ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.staatsangehoerigkeit': ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.familienstand':        ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.fruehere_adressen':    ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],

  // ── Self-reported debtor data (Antrag / Fragebogen) ───────────────────────
  'schuldner.name':                 ['beschluss', 'meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.vorname':              ['beschluss', 'meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.geschlecht':           ['meldeauskunft', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.betriebsstaette_adresse': ['insolvenzantrag', 'fragebogen', 'beschluss', 'sonstiges'],
  'schuldner.finanzamt':            ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.steuernummer':         ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.ust_id':               ['insolvenzantrag', 'fragebogen', 'handelsregister', 'sonstiges'],
  'schuldner.wirtschaftsjahr':      ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.telefon':              ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.mobiltelefon':         ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.email':                ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.bankverbindungen':     ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.insolvenzsonderkonto': ['insolvenzantrag', 'fragebogen', 'sonstiges'],
  'schuldner.steuerberater':        ['insolvenzantrag', 'fragebogen', 'sonstiges'],

  // ── Gutachterbestellung (court appointment document) ─────────────────────
  'gutachterbestellung':            ['gutachterbestellung', 'beschluss', 'insolvenzantrag', 'sonstiges'],

  // ── Investigation results (each source is authoritative for itself) ───────
  'ermittlungsergebnisse.grundbuch':          ['grundbuch', 'insolvenzantrag', 'sonstiges'],
  'ermittlungsergebnisse.gerichtsvollzieher': ['gerichtsvollzieher', 'insolvenzantrag', 'sonstiges'],
  'ermittlungsergebnisse.vollstreckungsportal': ['vollstreckungsportal', 'gerichtsvollzieher', 'sonstiges'],
  'ermittlungsergebnisse.meldeauskunft':      ['meldeauskunft', 'insolvenzantrag', 'sonstiges'],

  // ── Claims (Forderungen) ──────────────────────────────────────────────────
  'forderungen':                    ['forderungstabelle', 'insolvenzantrag', 'beschluss', 'sonstiges'],

  // ── Assets (Aktiva) ───────────────────────────────────────────────────────
  'aktiva':                         ['vermoegensverzeichnis', 'insolvenzantrag', 'fragebogen', 'sonstiges'],
};

// ─── Default Authority ───────────────────────────────────────────────────────
//
// Used when no matrix entry matches. Encodes the general trust hierarchy:
// official court docs > self-reported applicant docs > other

const DEFAULT_AUTHORITY: SegmentSourceType[] = [
  'beschluss',
  'pzu',
  'gutachterbestellung',
  'handelsregister',
  'meldeauskunft',
  'insolvenzantrag',
  'fragebogen',
  'grundbuch',
  'gerichtsvollzieher',
  'vollstreckungsportal',
  'forderungstabelle',
  'vermoegensverzeichnis',
  'sonstiges',
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the authority ranking (ordered SegmentSourceType[]) for a given
 * field path. Uses exact match first, then longest-prefix match, then
 * falls back to DEFAULT_AUTHORITY.
 */
export function getFieldAuthority(fieldPath: string): SegmentSourceType[] {
  // 1. Exact match
  if (fieldPath in AUTHORITY_MATRIX) {
    return AUTHORITY_MATRIX[fieldPath];
  }

  // 2. Longest prefix match (try progressively shorter prefixes)
  //    e.g. 'gutachterbestellung.gutachter_name' → tries 'gutachterbestellung'
  const parts = fieldPath.split('.');
  for (let len = parts.length - 1; len >= 1; len--) {
    const prefix = parts.slice(0, len).join('.');
    if (prefix in AUTHORITY_MATRIX) {
      return AUTHORITY_MATRIX[prefix];
    }
  }

  // 3. Default
  return DEFAULT_AUTHORITY;
}

/**
 * Picks the winning candidate from a non-empty list of candidates for the
 * same field.
 *
 * Resolution order:
 *   1. Authority rank (lower index in getFieldAuthority() = higher authority)
 *   2. Value string length (longer = more complete / detailed)
 *   3. Original list order (stable tie-break)
 *
 * Throws if candidates array is empty.
 */
export function resolveCandidate(candidates: ExtractionCandidate[]): ExtractionCandidate {
  if (candidates.length === 0) {
    throw new Error('resolveCandidate called with empty candidates array');
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const authority = getFieldAuthority(candidates[0].fieldPath);

  const rankOf = (c: ExtractionCandidate): number => {
    const idx = authority.indexOf(c.segmentType);
    return idx === -1 ? authority.length : idx; // unknown sources rank last
  };

  const valueLength = (c: ExtractionCandidate): number => {
    if (c.wert === null || c.wert === undefined) return 0;
    return String(c.wert).length;
  };

  // Stable sort: lower rank wins; on tie, longer value wins; on tie, original order wins.
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    const rankDiff = rankOf(a.c) - rankOf(b.c);
    if (rankDiff !== 0) return rankDiff;

    const lenDiff = valueLength(b.c) - valueLength(a.c); // longer first
    if (lenDiff !== 0) return lenDiff;

    return a.i - b.i; // preserve original order
  });

  return indexed[0].c;
}
