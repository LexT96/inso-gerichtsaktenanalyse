import { describe, it, expect } from 'vitest';
import { buildResultFromCandidates } from '../extractionReducer';
import type { ExtractionCandidate } from '../../types/extraction';

describe('buildResultFromCandidates', () => {
  it('sets a simple scalar field', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.aktenzeichen', wert: '35 IN 42/26', quelle: 'Seite 1, Beschluss', page: 1, segmentType: 'beschluss', packId: 'anchor' },
    ];
    const result = buildResultFromCandidates(candidates);
    expect(result.verfahrensdaten.aktenzeichen.wert).toBe('35 IN 42/26');
    expect(result.verfahrensdaten.aktenzeichen.quelle).toBe('Seite 1, Beschluss');
    expect(result.verfahrensdaten.aktenzeichen.verifiziert).toBe(false);
  });

  it('resolves conflicting candidates using authority', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.aktuelle_adresse', wert: 'Hauptstr. 1', quelle: 'Seite 5, Antrag', page: 5, segmentType: 'insolvenzantrag', packId: 'p1' },
      { fieldPath: 'schuldner.aktuelle_adresse', wert: 'Hauptstraße 1, 12345 Berlin', quelle: 'Seite 20, Meldeauskunft', page: 20, segmentType: 'meldeauskunft', packId: 'p2' },
    ];
    const result = buildResultFromCandidates(candidates);
    expect(result.schuldner.aktuelle_adresse.wert).toBe('Hauptstraße 1, 12345 Berlin');
  });

  it('handles nested objects (ermittlungsergebnisse.grundbuch.ergebnis)', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'ermittlungsergebnisse.grundbuch.ergebnis', wert: 'Grundbesitz vorhanden', quelle: 'Seite 25', page: 25, segmentType: 'grundbuch', packId: 'ermittlung' },
    ];
    const result = buildResultFromCandidates(candidates);
    expect(result.ermittlungsergebnisse.grundbuch.ergebnis.wert).toBe('Grundbesitz vorhanden');
  });

  it('returns empty result with no candidates', () => {
    const result = buildResultFromCandidates([]);
    expect(result.verfahrensdaten.aktenzeichen.wert).toBeNull();
    expect(result.schuldner.name.wert).toBeNull();
  });

  it('handles multiple fields from different packs', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.aktenzeichen', wert: '35 IN 42/26', quelle: 'S.1', page: 1, segmentType: 'beschluss', packId: 'anchor' },
      { fieldPath: 'schuldner.name', wert: 'Falkenrath', quelle: 'S.1', page: 1, segmentType: 'beschluss', packId: 'anchor' },
      { fieldPath: 'schuldner.geburtsdatum', wert: '04.09.1986', quelle: 'S.20', page: 20, segmentType: 'meldeauskunft', packId: 'personal' },
    ];
    const result = buildResultFromCandidates(candidates);
    expect(result.verfahrensdaten.aktenzeichen.wert).toBe('35 IN 42/26');
    expect(result.schuldner.name.wert).toBe('Falkenrath');
    expect(result.schuldner.geburtsdatum.wert).toBe('04.09.1986');
  });
});
