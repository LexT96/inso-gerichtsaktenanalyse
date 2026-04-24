import { describe, it, expect } from 'vitest';
import { HANDWRITING_FIELDS, getCriticalFields } from '../handwritingFieldRegistry';

describe('HANDWRITING_FIELDS registry', () => {
  it('has at least 20 field entries', () => {
    expect(HANDWRITING_FIELDS.length).toBeGreaterThanOrEqual(20);
  });

  it('each entry has required properties', () => {
    for (const f of HANDWRITING_FIELDS) {
      expect(typeof f.key).toBe('string');
      expect(f.key.length).toBeGreaterThan(0);
      expect(typeof f.path).toBe('string');
      expect(['critical', 'standard', 'optional']).toContain(f.criticality);
      expect(typeof f.label).toBe('string');
      expect(Array.isArray(f.anchors)).toBe(true);
      expect(f.anchors.length).toBeGreaterThan(0);
    }
  });

  it('keys are unique', () => {
    const keys = HANDWRITING_FIELDS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('paths start with schuldner.', () => {
    for (const f of HANDWRITING_FIELDS) {
      expect(f.path.startsWith('schuldner.')).toBe(true);
    }
  });

  it('critical fields include betriebsstaette_adresse, email, telefon, steuerberater, finanzamt, firma', () => {
    const critical = getCriticalFields().map(f => f.key);
    expect(critical).toContain('betriebsstaette_adresse');
    expect(critical).toContain('email');
    expect(critical).toContain('telefon');
    expect(critical).toContain('steuerberater');
    expect(critical).toContain('finanzamt');
    expect(critical).toContain('firma');
  });
});
