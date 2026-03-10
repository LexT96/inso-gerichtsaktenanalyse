import { describe, it, expect } from 'vitest';
import { parsePageNumber, replacePageNumber } from '../pageParser';

describe('parsePageNumber', () => {
  it('parses "Seite 3, Beschluss vom 18.12.2025" → 3', () => {
    expect(parsePageNumber('Seite 3, Beschluss vom 18.12.2025')).toBe(3);
  });

  it('parses "Seiten 5-7, Insolvenzantrag" → 5', () => {
    expect(parsePageNumber('Seiten 5-7, Insolvenzantrag')).toBe(5);
  });

  it('parses "S. 12, Mitteilung" → 12', () => {
    expect(parsePageNumber('S. 12, Mitteilung')).toBe(12);
  });

  it('parses "S.3" → 3', () => {
    expect(parsePageNumber('S.3')).toBe(3);
  });

  it('returns null for empty string', () => {
    expect(parsePageNumber('')).toBeNull();
  });

  it('returns null when no page reference exists', () => {
    expect(parsePageNumber('Beschluss vom 18.12.2025')).toBeNull();
  });
});

describe('replacePageNumber', () => {
  it('replaces "Seite 3, Beschluss vom 18.12.2025" page with 7', () => {
    expect(replacePageNumber('Seite 3, Beschluss vom 18.12.2025', 7))
      .toBe('Seite 7, Beschluss vom 18.12.2025');
  });

  it('replaces "S. 12, Mitteilung" page with 5', () => {
    expect(replacePageNumber('S. 12, Mitteilung', 5))
      .toBe('S. 5, Mitteilung');
  });

  it('replaces "S.3" page with 7', () => {
    expect(replacePageNumber('S.3', 7)).toBe('S.7');
  });
});
