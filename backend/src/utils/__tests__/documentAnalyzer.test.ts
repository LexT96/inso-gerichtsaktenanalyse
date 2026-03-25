import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    ANTHROPIC_API_KEY: 'test-key',
    UTILITY_MODEL: 'claude-haiku-4-5-20251001',
    EXTRACTION_MODEL: 'claude-sonnet-4-6',
  },
}));

vi.mock('../../services/anthropic', () => ({
  anthropic: { messages: { create: vi.fn() } },
  callWithRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseDocumentMap, findOrphanPages } from '../documentAnalyzer';

describe('parseDocumentMap', () => {
  it('parses standard DOKUMENTSTRUKTUR output', () => {
    const mapText = `DOKUMENTSTRUKTUR:
- Seiten 1-3: Beschluss — Eröffnung vorläufiges Verfahren, Az: 23 IN 165/25
- Seiten 4-8: Insolvenzantrag — Forderung: 12.345,67 EUR
- Seite 9: Zustellungsvermerk — PZU, handschriftl. 03.01.2025
- Seiten 10-12: Mitteilung des Gerichtsvollziehers — keine Vollstreckung möglich`;

    const segments = parseDocumentMap(mapText);

    expect(segments).toHaveLength(4);

    expect(segments[0].type).toBe('Beschluss');
    expect(segments[0].pages).toEqual([1, 2, 3]);
    expect(segments[0].description).toContain('Eröffnung');

    expect(segments[1].type).toBe('Insolvenzantrag');
    expect(segments[1].pages).toEqual([4, 5, 6, 7, 8]);

    expect(segments[2].type).toBe('Zustellungsvermerk');
    expect(segments[2].pages).toEqual([9]);

    expect(segments[3].type).toBe('Mitteilung des Gerichtsvollziehers');
    expect(segments[3].pages).toEqual([10, 11, 12]);
  });

  it('handles single page references', () => {
    const mapText = `- Seite 5: Grundbuchauskunft — kein Grundbesitz`;
    const segments = parseDocumentMap(mapText);

    expect(segments).toHaveLength(1);
    expect(segments[0].pages).toEqual([5]);
    expect(segments[0].type).toBe('Grundbuchauskunft');
  });

  it('handles "Seiten X und Y" format', () => {
    const mapText = `- Seiten 3 und 5: Korrespondenz — Schreiben an Schuldner`;
    const segments = parseDocumentMap(mapText);

    expect(segments).toHaveLength(1);
    expect(segments[0].pages).toEqual([3, 5]);
  });

  it('handles "Seiten X bis Y" format', () => {
    const mapText = `- Seiten 1 bis 4: Beschluss — Eröffnungsbeschluss`;
    const segments = parseDocumentMap(mapText);

    expect(segments).toHaveLength(1);
    expect(segments[0].pages).toEqual([1, 2, 3, 4]);
  });

  it('handles type without description (no dash separator)', () => {
    const mapText = `- Seite 15: Meldeauskunft`;
    const segments = parseDocumentMap(mapText);

    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe('Meldeauskunft');
    expect(segments[0].description).toBe('');
  });

  it('returns empty array for empty input', () => {
    expect(parseDocumentMap('')).toEqual([]);
    expect(parseDocumentMap('Some random text without structure')).toEqual([]);
  });

  it('ignores non-matching lines', () => {
    const mapText = `DOKUMENTSTRUKTUR:
Some preamble text
- Seite 1: Beschluss — Test
This is not a segment
- Seiten 2-3: Antrag — Test 2`;

    const segments = parseDocumentMap(mapText);
    expect(segments).toHaveLength(2);
  });

  it('handles bullet variants (•, *, –)', () => {
    const mapText = `• Seite 1: Beschluss — Test
* Seiten 2-3: Antrag — Test 2
– Seite 4: Verfügung — Test 3`;

    const segments = parseDocumentMap(mapText);
    expect(segments).toHaveLength(3);
  });
});

describe('findOrphanPages', () => {
  it('finds pages not covered by any segment', () => {
    const segments = [
      { type: 'Beschluss', pages: [1, 2, 3], description: '' },
      { type: 'Antrag', pages: [6, 7, 8], description: '' },
    ];

    const orphans = findOrphanPages(segments, 10);

    expect(orphans).toHaveLength(2);
    expect(orphans[0].pages).toEqual([4, 5]);
    expect(orphans[0].type).toBe('Sonstige Dokumente');
    expect(orphans[1].pages).toEqual([9, 10]);
  });

  it('returns empty when all pages are covered', () => {
    const segments = [
      { type: 'Beschluss', pages: [1, 2, 3], description: '' },
    ];

    const orphans = findOrphanPages(segments, 3);
    expect(orphans).toHaveLength(0);
  });

  it('handles empty segments', () => {
    const orphans = findOrphanPages([], 5);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].pages).toEqual([1, 2, 3, 4, 5]);
  });
});
