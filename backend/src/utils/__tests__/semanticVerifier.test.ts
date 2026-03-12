import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtractionResult } from '../../types/extraction';

// ─── Mocks ───

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../services/anthropic', () => ({
  anthropic: {
    messages: {
      create: vi.fn(),
    },
  },
  callWithRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  extractJsonFromText: vi.fn((text: string) => {
    const first = text.indexOf('[');
    const last = text.lastIndexOf(']');
    if (first >= 0 && last > first) return text.slice(first, last + 1);
    return text;
  }),
}));

// ─── Imports (after mocks are set up) ───

import { collectFields, semanticVerify } from '../semanticVerifier';
import { anthropic } from '../../services/anthropic';

// ─── Fixture ───

function sv(wert: string | null, quelle = 'Seite 1, Test'): { wert: string | null; quelle: string } {
  return { wert, quelle };
}

function sn(wert: number | null, quelle = 'Seite 1, Test'): { wert: number | null; quelle: string } {
  return { wert, quelle };
}

function makeResult(): ExtractionResult {
  return {
    verfahrensdaten: {
      aktenzeichen: sv('123 IN 456/24'),
      gericht: sv('Amtsgericht Musterstadt'),
      richter: sv('Dr. Mustermann'),
      antragsdatum: sv(null),
      beschlussdatum: sv('01.01.2024'),
      antragsart: sv(null),
      eroeffnungsgrund: sv(null),
      zustellungsdatum_schuldner: sv('05.01.2024'),
    },
    schuldner: {
      name: sv('Muster'),
      vorname: sv('Max'),
      geburtsdatum: sv(null),
      geburtsort: sv(null),
      geburtsland: sv(null),
      staatsangehoerigkeit: sv(null),
      familienstand: sv(null),
      geschlecht: sv(null),
      aktuelle_adresse: sv(null),
      fruehere_adressen: [],
      firma: sv(null),
      rechtsform: sv(null),
      betriebsstaette_adresse: sv(null),
      handelsregisternummer: sv(null),
      kinder: [],
    },
    antragsteller: {
      name: sv(null),
      adresse: sv(null),
      ansprechpartner: sv(null),
      telefon: sv(null),
      fax: sv(null),
      email: sv(null),
      betriebsnummer: sv(null),
      bankverbindung_iban: sv(null),
      bankverbindung_bic: sv(null),
    },
    forderungen: {
      hauptforderung_beitraege: sn(null),
      saeumniszuschlaege: sn(null),
      mahngebuehren: sn(null),
      vollstreckungskosten: sn(null),
      antragskosten: sn(null),
      gesamtforderung: sn(12345.67),
      zeitraum_von: sv(null),
      zeitraum_bis: sv(null),
      laufende_monatliche_beitraege: sn(null),
      betroffene_arbeitnehmer: [],
    },
    gutachterbestellung: {
      gutachter_name: sv(null),
      gutachter_kanzlei: sv(null),
      gutachter_adresse: sv(null),
      gutachter_telefon: sv(null),
      gutachter_email: sv(null),
      abgabefrist: sv(null),
      befugnisse: [],
    },
    ermittlungsergebnisse: {
      grundbuch: {
        ergebnis: sv(null),
        grundbesitz_vorhanden: { wert: null, quelle: '' },
        datum: sv(null),
      },
      gerichtsvollzieher: {
        name: sv(null),
        betriebsstaette_bekannt: { wert: null, quelle: '' },
        vollstreckungen: sv(null),
        masse_deckend: { wert: null, quelle: '' },
        vermoegensauskunft_abgegeben: { wert: null, quelle: '' },
        haftbefehle: { wert: null, quelle: '' },
        datum: sv(null),
      },
      vollstreckungsportal: {
        schuldnerverzeichnis_eintrag: { wert: null, quelle: '' },
        vermoegensverzeichnis_eintrag: { wert: null, quelle: '' },
      },
      meldeauskunft: {
        meldestatus: sv(null),
        datum: sv(null),
      },
    },
    fristen: [],
    standardanschreiben: [],
    fehlende_informationen: [],
    zusammenfassung: '',
    risiken_hinweise: [],
  };
}

// ─── Helper to build a mock API response ───

function mockApiResponse(entries: Array<{ nr: number; verifiziert: boolean; quelle_korrigiert?: string }>): void {
  const text = JSON.stringify(entries);
  vi.mocked(anthropic.messages.create).mockResolvedValueOnce({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  } as never);
}

// ─── Tests ───

describe('collectFields', () => {
  it('collects all non-empty wert fields — 8 from test fixture', () => {
    const result = makeResult();
    const fields = collectFields(result);
    expect(fields).toHaveLength(8);
  });

  it('skips fields with null wert', () => {
    const result = makeResult();
    // Only set one field to a value, everything else is null/empty
    const tiny: unknown = {
      verfahrensdaten: {
        aktenzeichen: { wert: 'AZ-001', quelle: 'Seite 1' },
        gericht: { wert: null, quelle: '' },
      },
    };
    const fields = collectFields(tiny);
    expect(fields).toHaveLength(1);
    expect(fields[0].path).toBe('verfahrensdaten.aktenzeichen');
  });

  it('skips fields with empty string wert', () => {
    const tiny: unknown = {
      schuldner: {
        name: { wert: '', quelle: '' },
        vorname: { wert: 'Hans', quelle: 'Seite 2' },
      },
    };
    const fields = collectFields(tiny);
    expect(fields).toHaveLength(1);
    expect(fields[0].ref.wert).toBe('Hans');
  });

  it('collects SourcedValue items found inside arrays (e.g. kinder)', () => {
    const result = makeResult();
    // Add two SourcedValue entries to kinder array
    result.schuldner.kinder = [
      { wert: 'Kind 1', quelle: 'Seite 3, Antrag' },
      { wert: 'Kind 2', quelle: 'Seite 3, Antrag' },
    ];
    const fields = collectFields(result);
    // 8 base fields + 2 kinder entries = 10
    expect(fields).toHaveLength(10);
    const kinderPaths = fields.filter(f => f.path.includes('kinder'));
    expect(kinderPaths).toHaveLength(2);
  });
});

describe('semanticVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets verifiziert: true for confirmed fields', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // Confirm all 8 fields
    const entries = fields.map((_, i) => ({ nr: i + 1, verifiziert: true }));
    mockApiResponse(entries);

    await semanticVerify(result, ['page text']);

    // All non-empty fields should be verified
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBe(true);
    expect(result.verfahrensdaten.gericht.verifiziert).toBe(true);
    expect(result.schuldner.name.verifiziert).toBe(true);
    expect(result.forderungen.gesamtforderung.verifiziert).toBe(true);
  });

  it('corrects quelle when quelle_korrigiert is provided', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // First field gets a corrected source; rest confirmed
    const entries = fields.map((_, i) =>
      i === 0
        ? { nr: 1, verifiziert: true, quelle_korrigiert: 'Seite 99, Korrektur' }
        : { nr: i + 1, verifiziert: true }
    );
    mockApiResponse(entries);

    await semanticVerify(result, ['page text']);

    // The first collected field should have its quelle updated
    const firstField = fields[0].ref;
    expect(firstField.verifiziert).toBe(true);
    expect(firstField.quelle).toBe('Seite 99, Korrektur');
  });

  it('sets verifiziert: false when value not found in document', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // Reject all fields
    const entries = fields.map((_, i) => ({ nr: i + 1, verifiziert: false }));
    mockApiResponse(entries);

    await semanticVerify(result, ['page text']);

    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBe(false);
    expect(result.schuldner.name.verifiziert).toBe(false);
    expect(result.forderungen.gesamtforderung.verifiziert).toBe(false);
  });

  it('leaves verifiziert undefined on API failure (graceful degradation)', async () => {
    const result = makeResult();
    vi.mocked(anthropic.messages.create).mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await expect(semanticVerify(result, ['page text'])).resolves.toBe(result);

    // Fields should remain untouched (verifiziert still undefined)
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBeUndefined();
    expect(result.schuldner.name.verifiziert).toBeUndefined();
  });

  it('handles malformed API response gracefully (no crash)', async () => {
    const result = makeResult();
    // Return non-JSON garbage
    vi.mocked(anthropic.messages.create).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all !!!' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    } as never);

    // Should not throw
    await expect(semanticVerify(result, ['page text'])).resolves.toBe(result);

    // Fields should be left unchanged
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBeUndefined();
  });

  it('returns the same result object (mutation in-place)', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    const entries = fields.map((_, i) => ({ nr: i + 1, verifiziert: true }));
    mockApiResponse(entries);

    const returned = await semanticVerify(result, ['page text']);

    expect(returned).toBe(result);
  });

  it('skips API call when no non-empty fields exist', async () => {
    // Build a result with all null/empty wert fields
    const empty: ExtractionResult = {
      verfahrensdaten: {
        aktenzeichen: sv(null),
        gericht: sv(null),
        richter: sv(null),
        antragsdatum: sv(null),
        beschlussdatum: sv(null),
        antragsart: sv(null),
        eroeffnungsgrund: sv(null),
        zustellungsdatum_schuldner: sv(null),
      },
      schuldner: {
        name: sv(null),
        vorname: sv(null),
        geburtsdatum: sv(null),
        geburtsort: sv(null),
        geburtsland: sv(null),
        staatsangehoerigkeit: sv(null),
        familienstand: sv(null),
        geschlecht: sv(null),
        aktuelle_adresse: sv(null),
        fruehere_adressen: [],
        firma: sv(null),
        rechtsform: sv(null),
        betriebsstaette_adresse: sv(null),
        handelsregisternummer: sv(null),
        kinder: [],
      },
      antragsteller: {
        name: sv(null),
        adresse: sv(null),
        ansprechpartner: sv(null),
        telefon: sv(null),
        fax: sv(null),
        email: sv(null),
        betriebsnummer: sv(null),
        bankverbindung_iban: sv(null),
        bankverbindung_bic: sv(null),
      },
      forderungen: {
        hauptforderung_beitraege: sn(null),
        saeumniszuschlaege: sn(null),
        mahngebuehren: sn(null),
        vollstreckungskosten: sn(null),
        antragskosten: sn(null),
        gesamtforderung: sn(null),
        zeitraum_von: sv(null),
        zeitraum_bis: sv(null),
        laufende_monatliche_beitraege: sn(null),
        betroffene_arbeitnehmer: [],
      },
      gutachterbestellung: {
        gutachter_name: sv(null),
        gutachter_kanzlei: sv(null),
        gutachter_adresse: sv(null),
        gutachter_telefon: sv(null),
        gutachter_email: sv(null),
        abgabefrist: sv(null),
        befugnisse: [],
      },
      ermittlungsergebnisse: {
        grundbuch: {
          ergebnis: sv(null),
          grundbesitz_vorhanden: { wert: null, quelle: '' },
          datum: sv(null),
        },
        gerichtsvollzieher: {
          name: sv(null),
          betriebsstaette_bekannt: { wert: null, quelle: '' },
          vollstreckungen: sv(null),
          masse_deckend: { wert: null, quelle: '' },
          vermoegensauskunft_abgegeben: { wert: null, quelle: '' },
          haftbefehle: { wert: null, quelle: '' },
          datum: sv(null),
        },
        vollstreckungsportal: {
          schuldnerverzeichnis_eintrag: { wert: null, quelle: '' },
          vermoegensverzeichnis_eintrag: { wert: null, quelle: '' },
        },
        meldeauskunft: {
          meldestatus: sv(null),
          datum: sv(null),
        },
      },
      fristen: [],
      standardanschreiben: [],
      fehlende_informationen: [],
      zusammenfassung: '',
      risiken_hinweise: [],
    };

    const returned = await semanticVerify(empty, ['page text']);

    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(returned).toBe(empty);
  });
});
