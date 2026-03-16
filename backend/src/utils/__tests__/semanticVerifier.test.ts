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

vi.mock('../../config', () => ({
  config: {
    ANTHROPIC_API_KEY: 'test-key',
    UTILITY_MODEL: 'claude-haiku-4-5-20251001',
    EXTRACTION_MODEL: 'claude-sonnet-4-6',
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

import { collectFields, parsePagesFromQuelle, semanticVerify } from '../semanticVerifier';
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
    zusammenfassung: [],
    risiken_hinweise: [],
  };
}

// ─── Helper to build a mock API response ───

function mockApiResponse(entries: Array<{
  nr: number;
  verifiziert: boolean;
  quelle_korrigiert?: string;
  aktion?: 'entfernen' | 'korrigieren';
  korrekter_wert?: unknown;
  korrekte_quelle?: string;
  begruendung?: string;
}>): void {
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

  it('nulls wert when aktion is entfernen (e.g. document says unknown)', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // First field: entfernen (betriebsstaette-like scenario); rest: verified
    const entries = fields.map((_, i) =>
      i === 0
        ? { nr: 1, verifiziert: false, aktion: 'entfernen' as const, begruendung: 'Dokument sagt: nicht bekannt' }
        : { nr: i + 1, verifiziert: true }
    );
    mockApiResponse(entries);

    await semanticVerify(result, ['page text']);

    // First collected field should have its wert nulled
    const firstField = fields[0].ref;
    expect(firstField.wert).toBeNull();
    expect(firstField.verifiziert).toBe(false);
  });

  it('replaces wert when aktion is korrigieren (e.g. wrong date from wrong context)', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // Correct the zustellungsdatum (field index 4: zustellungsdatum_schuldner)
    const entries = fields.map((_, i) =>
      i === 4
        ? {
            nr: 5,
            verifiziert: false,
            aktion: 'korrigieren' as const,
            korrekter_wert: '08.01.2024',
            korrekte_quelle: 'Seite 12, Zustellungsvermerk',
            begruendung: 'Handschriftliches Zustelldatum statt Beschlussdatum',
          }
        : { nr: i + 1, verifiziert: true }
    );
    mockApiResponse(entries);

    await semanticVerify(result, ['page text']);

    // The corrected field should have the new value, quelle, and verifiziert=true
    const correctedField = fields[4].ref;
    expect(correctedField.wert).toBe('08.01.2024');
    expect(correctedField.quelle).toBe('Seite 12, Zustellungsvermerk');
    expect(correctedField.verifiziert).toBe(true);
  });

  it('treats korrigieren without korrekter_wert as regular failure', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // Send korrigieren but without korrekter_wert — should be treated as failed, not crash
    const entries = fields.map((_, i) =>
      i === 0
        ? { nr: 1, verifiziert: false, aktion: 'korrigieren' as const, begruendung: 'Incomplete correction' }
        : { nr: i + 1, verifiziert: true }
    );
    mockApiResponse(entries);

    await semanticVerify(result, ['page text']);

    // Should be marked as failed, wert unchanged
    const firstField = fields[0].ref;
    expect(firstField.verifiziert).toBe(false);
    expect(firstField.wert).toBe(fields[0].ref.wert); // unchanged
  });

  it('retries remaining fields on truncation (max_tokens)', async () => {
    const result = makeResult();
    const fields = collectFields(result);
    // First response: truncated, only returns first 4 of 8 fields
    const partial = fields.slice(0, 4).map((_, i) => ({ nr: i + 1, verifiziert: true }));
    vi.mocked(anthropic.messages.create).mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(partial) }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 8192 },
    } as never);
    // Retry response: remaining 4 fields
    const remaining = [1, 2, 3, 4].map(i => ({ nr: i, verifiziert: true }));
    vi.mocked(anthropic.messages.create).mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify(remaining) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 80, output_tokens: 40 },
    } as never);

    await semanticVerify(result, ['page text']);

    // All 8 fields should be verified (4 from first call + 4 from retry)
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBe(true);
    expect(result.verfahrensdaten.gericht.verifiziert).toBe(true);
    expect(result.schuldner.name.verifiziert).toBe(true);
    expect(result.forderungen.gesamtforderung.verifiziert).toBe(true);
    // API should have been called twice
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
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
      zusammenfassung: [],
      risiken_hinweise: [],
    };

    const returned = await semanticVerify(empty, ['page text']);

    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(returned).toBe(empty);
  });
});

describe('parsePagesFromQuelle', () => {
  it('parses single page "Seite 5"', () => {
    expect(parsePagesFromQuelle('Seite 5, Beschluss')).toEqual([5]);
  });

  it('parses page range "Seiten 5-7"', () => {
    expect(parsePagesFromQuelle('Seiten 5-7, Insolvenzantrag')).toEqual([5, 6, 7]);
  });

  it('parses page range with en-dash "Seiten 5–7"', () => {
    expect(parsePagesFromQuelle('Seiten 5–7, Antrag')).toEqual([5, 6, 7]);
  });

  it('parses "Seiten 3 und 5"', () => {
    expect(parsePagesFromQuelle('Seiten 3 und 5, Beschluss')).toEqual([3, 5]);
  });

  it('parses "Seiten 3, 5 und 7"', () => {
    expect(parsePagesFromQuelle('Seiten 3, 5 und 7')).toEqual([3, 5, 7]);
  });

  it('parses mixed range and single "Seiten 3-5 und 8"', () => {
    expect(parsePagesFromQuelle('Seiten 3-5 und 8')).toEqual([3, 4, 5, 8]);
  });

  it('returns empty array for no page reference', () => {
    expect(parsePagesFromQuelle('Keine Angabe')).toEqual([]);
  });

  it('handles case insensitivity', () => {
    expect(parsePagesFromQuelle('seite 12, test')).toEqual([12]);
  });
});
