import { describe, it, expect } from 'vitest';
import { getFieldAuthority, resolveCandidate } from '../fieldAuthority';
import type { ExtractionCandidate } from '../../types/extraction';

describe('fieldAuthority', () => {
  it('returns authority ranking for known field', () => {
    const auth = getFieldAuthority('verfahrensdaten.aktenzeichen');
    expect(auth).toContain('beschluss');
    expect(auth.indexOf('beschluss')).toBeLessThan(auth.indexOf('insolvenzantrag'));
  });

  it('returns default ranking for unknown field', () => {
    const auth = getFieldAuthority('some.unknown.field');
    expect(auth.length).toBeGreaterThan(0);
  });

  it('resolves candidates by authority — beschluss wins for aktenzeichen', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.aktenzeichen', wert: '35 IN 42/26', quelle: 'Seite 3, Antrag', page: 3, segmentType: 'insolvenzantrag', packId: 'anchor' },
      { fieldPath: 'verfahrensdaten.aktenzeichen', wert: '35 IN 42/26', quelle: 'Seite 1, Beschluss', page: 1, segmentType: 'beschluss', packId: 'anchor' },
    ];
    const winner = resolveCandidate(candidates);
    expect(winner.quelle).toContain('Beschluss');
  });

  it('resolves candidates — meldeauskunft wins for aktuelle_adresse', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.aktuelle_adresse', wert: 'Hauptstr. 1', quelle: 'Seite 5, Antrag', page: 5, segmentType: 'insolvenzantrag', packId: 'schuldner_personal' },
      { fieldPath: 'schuldner.aktuelle_adresse', wert: 'Hauptstraße 1, 12345 Berlin', quelle: 'Seite 20, Meldeauskunft', page: 20, segmentType: 'meldeauskunft', packId: 'schuldner_personal' },
    ];
    const winner = resolveCandidate(candidates);
    expect(winner.quelle).toContain('Meldeauskunft');
  });

  it('prefers longer value at equal authority', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'schuldner.name', wert: 'Müller', quelle: 'Seite 1', page: 1, segmentType: 'beschluss', packId: 'anchor' },
      { fieldPath: 'schuldner.name', wert: 'Müller-Schmidt', quelle: 'Seite 4', page: 4, segmentType: 'beschluss', packId: 'schuldner_personal' },
    ];
    const winner = resolveCandidate(candidates);
    expect(winner.wert).toBe('Müller-Schmidt');
  });

  it('handles single candidate', () => {
    const candidates: ExtractionCandidate[] = [
      { fieldPath: 'verfahrensdaten.gericht', wert: 'AG München', quelle: 'Seite 1', page: 1, segmentType: 'beschluss', packId: 'anchor' },
    ];
    const winner = resolveCandidate(candidates);
    expect(winner.wert).toBe('AG München');
  });

  it('uses prefix matching for nested fields', () => {
    const auth = getFieldAuthority('gutachterbestellung.gutachter_name');
    expect(auth).toContain('gutachterbestellung');
  });
});
