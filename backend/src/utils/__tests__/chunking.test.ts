import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config', () => ({
  config: {
    ANTHROPIC_API_KEY: 'test-key',
    UTILITY_MODEL: 'claude-haiku-4-5-20251001',
    EXTRACTION_MODEL: 'claude-sonnet-4-6',
  },
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildDocumentAwareChunks } from '../../services/anthropic';
import type { DocumentSegment } from '../documentAnalyzer';

describe('buildDocumentAwareChunks', () => {
  it('groups small segments into single chunk', () => {
    const segments: DocumentSegment[] = [
      { type: 'Beschluss', pages: [1, 2, 3], description: '' },
      { type: 'Antrag', pages: [4, 5, 6, 7, 8], description: '' },
      { type: 'PZU', pages: [9], description: '' },
    ];

    const chunks = buildDocumentAwareChunks(segments, 40);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('splits into multiple chunks respecting document boundaries', () => {
    const segments: DocumentSegment[] = [
      { type: 'Beschluss', pages: [1, 2, 3], description: '' },
      { type: 'Antrag', pages: [4, 5, 6, 7, 8, 9, 10], description: '' },
      { type: 'GV-Mitteilung', pages: [11, 12, 13, 14, 15], description: '' },
      { type: 'Grundbuch', pages: [16, 17], description: '' },
    ];

    // Max 10 pages per chunk
    const chunks = buildDocumentAwareChunks(segments, 10);

    expect(chunks).toHaveLength(2);
    // First chunk: Beschluss (3) + Antrag (7) = 10 pages
    expect(chunks[0].pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Second chunk: GV-Mitteilung (5) + Grundbuch (2) = 7 pages
    expect(chunks[1].pages).toEqual([11, 12, 13, 14, 15, 16, 17]);
  });

  it('never splits a single document across chunks', () => {
    const segments: DocumentSegment[] = [
      { type: 'Small', pages: [1, 2], description: '' },
      { type: 'Large', pages: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12], description: '' }, // 10 pages
      { type: 'After', pages: [13], description: '' },
    ];

    // Max 5 pages — the large document can't be split
    const chunks = buildDocumentAwareChunks(segments, 5);

    expect(chunks).toHaveLength(3);
    expect(chunks[0].pages).toEqual([1, 2]);
    expect(chunks[1].pages).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // Stays together
    expect(chunks[2].pages).toEqual([13]);
  });

  it('generates document context labels', () => {
    const segments: DocumentSegment[] = [
      { type: 'Beschluss', pages: [1, 2, 3], description: '' },
      { type: 'Insolvenzantrag', pages: [4, 5], description: '' },
    ];

    const chunks = buildDocumentAwareChunks(segments, 40);

    expect(chunks[0].documentContext).toContain('Beschluss');
    expect(chunks[0].documentContext).toContain('Insolvenzantrag');
  });

  it('excludes "Sonstige Dokumente" from context labels', () => {
    const segments: DocumentSegment[] = [
      { type: 'Beschluss', pages: [1, 2], description: '' },
      { type: 'Sonstige Dokumente', pages: [3, 4], description: '' },
    ];

    const chunks = buildDocumentAwareChunks(segments, 40);

    expect(chunks[0].documentContext).toContain('Beschluss');
    expect(chunks[0].documentContext).not.toContain('Sonstige');
  });

  it('handles empty segments', () => {
    const chunks = buildDocumentAwareChunks([], 40);
    expect(chunks).toEqual([]);
  });

  it('deduplicates overlapping pages', () => {
    const segments: DocumentSegment[] = [
      { type: 'A', pages: [1, 2, 3], description: '' },
      { type: 'B', pages: [3, 4, 5], description: '' }, // page 3 overlaps
    ];

    const chunks = buildDocumentAwareChunks(segments, 40);

    expect(chunks[0].pages).toEqual([1, 2, 3, 4, 5]); // No duplicate page 3
  });
});
