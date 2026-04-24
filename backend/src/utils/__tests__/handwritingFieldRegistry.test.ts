import { describe, it, expect } from 'vitest';
import { HANDWRITING_FIELDS, getCriticalFields, buildMainPrompt, buildProbePrompt } from '../handwritingFieldRegistry';

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

describe('buildMainPrompt', () => {
  it('mentions every registry field key in the JSON schema example', () => {
    const prompt = buildMainPrompt(HANDWRITING_FIELDS);
    for (const f of HANDWRITING_FIELDS) {
      expect(prompt).toContain(f.key);
    }
  });

  it('contains the shared OCR-specialist framing', () => {
    const prompt = buildMainPrompt(HANDWRITING_FIELDS);
    expect(prompt).toContain('OCR-Spezialist');
    expect(prompt).toContain('Fragebögen');
  });

  it('instructs Claude to omit empty/unreadable fields', () => {
    const prompt = buildMainPrompt(HANDWRITING_FIELDS);
    expect(prompt).toMatch(/NICHT aufnehmen/i);
  });
});

describe('buildProbePrompt', () => {
  it('produces a single-field prompt for a specific registry entry', () => {
    const field = getCriticalFields().find(f => f.key === 'betriebsstaette_adresse')!;
    const prompt = buildProbePrompt(field);
    expect(prompt).toContain('betriebsstaette_adresse');
    expect(prompt).toContain('Betriebsstätte');
    expect(prompt).toContain('Anschrift der Firma');
  });

  it('includes edgeCases in the prompt when present', () => {
    const field = getCriticalFields().find(f => f.key === 'betriebsstaette_adresse')!;
    const prompt = buildProbePrompt(field);
    expect(prompt).toContain('identisch mit Privatanschrift');
  });

  it('includes negativeAnchors when present', () => {
    const field = HANDWRITING_FIELDS.find(f => f.key === 'telefon')!;
    const prompt = buildProbePrompt(field);
    expect(prompt).toContain('Fax');
  });

  it('does NOT mention other field keys (focused prompt)', () => {
    const field = getCriticalFields().find(f => f.key === 'email')!;
    const prompt = buildProbePrompt(field);
    expect(prompt).not.toContain('betriebsstaette_adresse');
    expect(prompt).not.toContain('steuerberater');
  });

  it('requests JSON with wert + quelle', () => {
    const field = getCriticalFields().find(f => f.key === 'email')!;
    const prompt = buildProbePrompt(field);
    expect(prompt).toContain('wert');
    expect(prompt).toContain('quelle');
  });
});
