import '../../env'; // Load .env before importing config
import { describe, it, expect } from 'vitest';
import { chunk } from '../extraction';

describe('chunk', () => {
  it('returns empty array for empty input', () => {
    expect(chunk([], 4)).toEqual([]);
  });
  it('returns single chunk when input shorter than size', () => {
    expect(chunk([1, 2], 4)).toEqual([[1, 2]]);
  });
  it('splits exact multiple', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  it('splits uneven, last chunk shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('throws on size <= 0', () => {
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});
