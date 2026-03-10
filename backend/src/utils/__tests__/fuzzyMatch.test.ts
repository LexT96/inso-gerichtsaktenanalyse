import { describe, it, expect } from 'vitest';
import { fuzzyFindInText } from '../fuzzyMatch';

const pageText = `Amtsgericht Köln, Az: 73 IN 123/25
Schuldner: Max Mustermann, geb. 15.03.1985
Anschrift: Musterstraße 42, 50667 Köln
Gesamtforderung: 12.345,67 EUR
Beschluss vom 18.12.2025`;

describe('fuzzyFindInText', () => {
  it('finds exact match "Max Mustermann"', () => {
    expect(fuzzyFindInText('Max Mustermann', pageText)).toBe(true);
  });

  it('finds case-insensitive match "max mustermann"', () => {
    expect(fuzzyFindInText('max mustermann', pageText)).toBe(true);
  });

  it('finds match with extra whitespace "Max  Mustermann"', () => {
    expect(fuzzyFindInText('Max  Mustermann', pageText)).toBe(true);
  });

  it('finds date "15.03.1985"', () => {
    expect(fuzzyFindInText('15.03.1985', pageText)).toBe(true);
  });

  it('finds parsed number "12345.67" (standard format matching German format)', () => {
    expect(fuzzyFindInText('12345.67', pageText)).toBe(true);
  });

  it('finds German format number "12.345,67"', () => {
    expect(fuzzyFindInText('12.345,67', pageText)).toBe(true);
  });

  it('finds case number "73 IN 123/25"', () => {
    expect(fuzzyFindInText('73 IN 123/25', pageText)).toBe(true);
  });

  it('finds partial name "Mustermann"', () => {
    expect(fuzzyFindInText('Mustermann', pageText)).toBe(true);
  });

  it('does not find "Hamburg"', () => {
    expect(fuzzyFindInText('Hamburg', pageText)).toBe(false);
  });

  it('skips boolean "true"', () => {
    expect(fuzzyFindInText('true', pageText)).toBe(true);
  });

  it('skips boolean "false"', () => {
    expect(fuzzyFindInText('false', pageText)).toBe(true);
  });

  it('skips short value "m"', () => {
    expect(fuzzyFindInText('m', pageText)).toBe(true);
  });

  it('finds full address "Musterstraße 42, 50667 Köln"', () => {
    expect(fuzzyFindInText('Musterstraße 42, 50667 Köln', pageText)).toBe(true);
  });

  it('finds OCR typo "Max Musterrnann" via Levenshtein', () => {
    expect(fuzzyFindInText('Max Musterrnann', pageText)).toBe(true);
  });
});
