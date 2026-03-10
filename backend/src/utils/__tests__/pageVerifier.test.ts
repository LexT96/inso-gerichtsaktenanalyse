import { describe, it, expect, vi } from 'vitest';

// Mock the logger to avoid filesystem side effects in tests
vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { verifyPageReferences } from '../pageVerifier';
import type { ExtractionResult } from '../../../types/extraction';

/**
 * Create a minimal ExtractionResult fixture for testing.
 * Only the fields we care about are populated; the rest use empty defaults.
 */
function makeMinimalResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  const sv = (wert: string | null, quelle: string) => ({ wert, quelle });
  const sn = (wert: number | null, quelle: string) => ({ wert, quelle });
  const sb = (wert: boolean | null, quelle: string) => ({ wert, quelle });

  return {
    verfahrensdaten: {
      aktenzeichen: sv('73 IN 123/25', 'Seite 1, Beschluss'),
      gericht: sv('Amtsgericht Köln', 'Seite 1, Beschluss'),
      richter: sv('Richter Schmidt', 'Seite 2, Beschluss'),
      antragsdatum: sv(null, ''),
      beschlussdatum: sv('18.12.2025', 'Seite 3, Beschluss'),
      antragsart: sv('', ''),
      eroeffnungsgrund: sv('Zahlungsunfähigkeit', ''),
      zustellungsdatum_schuldner: sv('20.12.2025', 'Seite 5, Beschluss'),
    },
    schuldner: {
      name: sv('Mustermann', 'Seite 1, Beschluss'),
      vorname: sv('Max', 'Seite 1, Beschluss'),
      geburtsdatum: sv('', ''),
      geburtsort: sv('', ''),
      geburtsland: sv('', ''),
      staatsangehoerigkeit: sv('', ''),
      familienstand: sv('', ''),
      geschlecht: sv('', ''),
      aktuelle_adresse: sv('', ''),
      fruehere_adressen: [],
      firma: sv('', ''),
      rechtsform: sv('', ''),
      betriebsstaette_adresse: sv('', ''),
      handelsregisternummer: sv('', ''),
      kinder: [],
    },
    antragsteller: {
      name: sv('', ''),
      adresse: sv('', ''),
      ansprechpartner: sv('', ''),
      telefon: sv('', ''),
      fax: sv('', ''),
      email: sv('', ''),
      betriebsnummer: sv('', ''),
      bankverbindung_iban: sv('', ''),
      bankverbindung_bic: sv('', ''),
    },
    forderungen: {
      hauptforderung_beitraege: sn(null, ''),
      saeumniszuschlaege: sn(null, ''),
      mahngebuehren: sn(null, ''),
      vollstreckungskosten: sn(null, ''),
      antragskosten: sn(null, ''),
      gesamtforderung: sn(12345.67, 'Seite 1, Forderungsaufstellung'),
      zeitraum_von: sv('', ''),
      zeitraum_bis: sv('', ''),
      laufende_monatliche_beitraege: sn(null, ''),
      betroffene_arbeitnehmer: [],
    },
    gutachterbestellung: {
      gutachter_name: sv('', ''),
      gutachter_kanzlei: sv('', ''),
      gutachter_adresse: sv('', ''),
      gutachter_telefon: sv('', ''),
      gutachter_email: sv('', ''),
      abgabefrist: sv('', ''),
      befugnisse: [],
    },
    ermittlungsergebnisse: {
      grundbuch: {
        ergebnis: sv('', ''),
        grundbesitz_vorhanden: sb(null, ''),
        datum: sv('', ''),
      },
      gerichtsvollzieher: {
        name: sv('', ''),
        betriebsstaette_bekannt: sb(null, ''),
        vollstreckungen: sv('', ''),
        masse_deckend: sb(null, ''),
        vermoegensauskunft_abgegeben: sb(null, ''),
        haftbefehle: sb(null, ''),
        datum: sv('', ''),
      },
      vollstreckungsportal: {
        schuldnerverzeichnis_eintrag: sb(null, ''),
        vermoegensverzeichnis_eintrag: sb(null, ''),
      },
      meldeauskunft: {
        meldestatus: sv('', ''),
        datum: sv('', ''),
      },
    },
    fristen: [],
    standardanschreiben: [],
    fehlende_informationen: [],
    zusammenfassung: '',
    risiken_hinweise: [],
    ...overrides,
  };
}

const pageTexts = [
  // Page 1
  `Amtsgericht Köln, Az: 73 IN 123/25
Schuldner: Max Mustermann
Gesamtforderung: 12.345,67 EUR`,
  // Page 2
  `Beschluss vom 18.12.2025
Richter Schmidt hat entschieden...`,
  // Page 3
  `Zustellungsvermerk
Zugestellt am 20.12.2025`,
];

describe('verifyPageReferences', () => {
  it('sets verifiziert: true when value is found on the correct page', () => {
    const result = makeMinimalResult();
    verifyPageReferences(result, pageTexts);

    // "73 IN 123/25" referenced Seite 1, found on page 1
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBe(true);
    // "Amtsgericht Köln" referenced Seite 1, found on page 1
    expect(result.verfahrensdaten.gericht.verifiziert).toBe(true);
    // "Mustermann" referenced Seite 1, found on page 1
    expect(result.schuldner.name.verifiziert).toBe(true);
  });

  it('corrects quelle and sets verifiziert: true when value found on a different page', () => {
    const result = makeMinimalResult();
    verifyPageReferences(result, pageTexts);

    // "18.12.2025" was referenced as Seite 3 but is actually on page 2
    expect(result.verfahrensdaten.beschlussdatum.verifiziert).toBe(true);
    expect(result.verfahrensdaten.beschlussdatum.quelle).toBe('Seite 2, Beschluss');

    // "Richter Schmidt" referenced Seite 2, found on page 2
    expect(result.verfahrensdaten.richter.verifiziert).toBe(true);
    expect(result.verfahrensdaten.richter.quelle).toBe('Seite 2, Beschluss');
  });

  it('sets verifiziert: false when value is not found on any page', () => {
    const result = makeMinimalResult();
    // "20.12.2025" is referenced as Seite 5 (out of range), but it IS on page 3
    verifyPageReferences(result, pageTexts);

    // It should be corrected to page 3
    expect(result.verfahrensdaten.zustellungsdatum_schuldner.verifiziert).toBe(true);
    expect(result.verfahrensdaten.zustellungsdatum_schuldner.quelle).toBe('Seite 3, Beschluss');
  });

  it('sets verifiziert: false for value truly not found anywhere', () => {
    const result = makeMinimalResult({
      verfahrensdaten: {
        ...makeMinimalResult().verfahrensdaten,
        antragsart: { wert: 'Eigenantrag', quelle: 'Seite 1, Beschluss' },
      },
    });
    verifyPageReferences(result, pageTexts);

    // "Eigenantrag" does not appear on any page
    expect(result.verfahrensdaten.antragsart.verifiziert).toBe(false);
  });

  it('skips fields with null wert (verifiziert remains undefined)', () => {
    const result = makeMinimalResult();
    verifyPageReferences(result, pageTexts);

    // antragsdatum has null wert
    expect(result.verfahrensdaten.antragsdatum.verifiziert).toBeUndefined();
  });

  it('skips fields with no page reference in quelle (verifiziert remains undefined)', () => {
    const result = makeMinimalResult();
    verifyPageReferences(result, pageTexts);

    // eroeffnungsgrund has a value but empty quelle (no page reference)
    expect(result.verfahrensdaten.eroeffnungsgrund.verifiziert).toBeUndefined();
  });

  it('handles numeric wert values (SourcedNumber)', () => {
    const result = makeMinimalResult();
    verifyPageReferences(result, pageTexts);

    // gesamtforderung: 12345.67 referenced Seite 1, "12.345,67" is on page 1
    expect(result.forderungen.gesamtforderung.verifiziert).toBe(true);
  });

  it('returns the same result object (mutation)', () => {
    const result = makeMinimalResult();
    const returned = verifyPageReferences(result, pageTexts);
    expect(returned).toBe(result);
  });
});
