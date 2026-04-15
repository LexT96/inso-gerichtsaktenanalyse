import { describe, it, expect } from 'vitest';
import { computeMergeDiff } from '../documentMerge';
import type { ExtractionCandidate, ExtractionResult } from '../../types/extraction';

function sv(wert: string | null, quelle = ''): { wert: string | null; quelle: string } {
  return { wert, quelle };
}

function makeMinimalResult(): ExtractionResult {
  return {
    verfahrensdaten: { aktenzeichen: sv('35 IN 42/26', 'Seite 1'), gericht: sv(null) },
    schuldner: { name: sv('Müller', 'Seite 1'), aktuelle_adresse: sv('Alt 1', 'Seite 5, Antrag'), telefon: sv('0651-111', 'Seite 8') },
    forderungen: { einzelforderungen: [{ glaeubiger: sv('Sparkasse'), betrag: { wert: 12450, quelle: 'S.20' } }] },
  } as unknown as ExtractionResult;
}

describe('computeMergeDiff', () => {
  it('detects new fields (existing is null)', () => {
    const existing = makeMinimalResult();
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.gericht', wert: 'AG Trier', quelle: 'Grundbuchauszug, Seite 1', page: 1, segmentType: 'grundbuch', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.newFields).toHaveLength(1);
    expect(diff.newFields[0].path).toBe('verfahrensdaten.gericht');
    expect(diff.newFields[0].wert).toBe('AG Trier');
  });

  it('detects updated fields (authority wins)', () => {
    const existing = makeMinimalResult();
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.aktuelle_adresse', wert: 'Neu 5, 12345 Berlin', quelle: 'Meldeauskunft, Seite 1', page: 1, segmentType: 'meldeauskunft', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.updatedFields).toHaveLength(1);
    expect(diff.updatedFields[0].oldWert).toBe('Alt 1');
    expect(diff.updatedFields[0].wert).toBe('Neu 5, 12345 Berlin');
  });

  it('detects conflicts for manually corrected fields', () => {
    const existing = makeMinimalResult();
    (existing.schuldner.telefon as any).pruefstatus = 'manuell';
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.telefon', wert: '0651-222', quelle: 'Meldeauskunft, Seite 2', page: 2, segmentType: 'meldeauskunft', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.conflicts).toHaveLength(1);
    expect(diff.conflicts[0].path).toBe('schuldner.telefon');
  });

  it('skips candidates with same value as existing', () => {
    const existing = makeMinimalResult();
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.aktenzeichen', wert: '35 IN 42/26', quelle: 'Grundbuchauszug, Seite 1', page: 1, segmentType: 'grundbuch', packId: 'test' },
    ];
    const diff = computeMergeDiff(existing, candidates);
    expect(diff.newFields).toHaveLength(0);
    expect(diff.updatedFields).toHaveLength(0);
    expect(diff.conflicts).toHaveLength(0);
  });
});
