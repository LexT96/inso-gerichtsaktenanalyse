import { describe, it, expect, beforeAll } from 'vitest';
import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import { generateLetterFromTemplate } from '../letterGenerator';
import type { ExtractionResult } from '../../types/extraction';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function readDocxText(buf: Buffer): string {
  const zip = new PizZip(buf);
  const xml = zip.file('word/document.xml')!.asText();
  const texts: string[] = [];
  for (const m of xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) texts.push(m[1]);
  return texts.join('');
}

describe('generateLetterFromTemplate', () => {
  const fixture = path.join(FIXTURE_DIR, 'test-letter.docx');
  let template: Buffer;
  beforeAll(() => { template = fs.readFileSync(fixture); });

  const baseResult = {
    verfahrensdaten: {
      aktenzeichen: { wert: '12 IN 123/24', quelle: 'Seite 1' },
      gericht: { wert: 'Amtsgericht München', quelle: 'Seite 1' },
      beschlussdatum: { wert: '15.03.2024', quelle: 'Seite 1' },
    },
    schuldner: {
      name: { wert: 'Mustermann', quelle: 'Seite 1' },
      vorname: { wert: 'Max', quelle: 'Seite 1' },
      geschlecht: { wert: 'maennlich', quelle: 'Seite 1' },
    },
  } as unknown as ExtractionResult;

  const baseVerwalter = {
    name: 'Prof. Dr. Schmidt',
    art: 'Insolvenzverwalter',
    diktatzeichen: 'TBS/ab',
    geschlecht: 'maennlich' as const,
  };

  it('replaces scalar path placeholders', () => {
    const out = generateLetterFromTemplate(template, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('12 IN 123/24');
    expect(text).toContain('15.03.2024');
    expect(text).not.toContain('FELD_Akte_Aktenzeichen');
    expect(text).not.toContain('FELD_Akte_LastGAVV');
  });

  it('replaces gender-computed placeholders for male', () => {
    const out = generateLetterFromTemplate(template, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('der Schuldner wohnt');
  });

  it('replaces gender-computed placeholders for female', () => {
    const resultFemale = {
      ...baseResult,
      schuldner: { ...baseResult.schuldner, geschlecht: { wert: 'weiblich', quelle: 'x' } },
    } as ExtractionResult;
    const out = generateLetterFromTemplate(template, resultFemale, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('die Schuldnerin wohnt');
  });

  it('replaces verwalter fields', () => {
    const out = generateLetterFromTemplate(template, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('TBS/ab Prof. Dr. Schmidt als Insolvenzverwalter');
  });

  it('leaves missing placeholders empty (no FELD_ leakage)', () => {
    const thin = { verfahrensdaten: {}, schuldner: {} } as unknown as ExtractionResult;
    const out = generateLetterFromTemplate(template, thin, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).not.toMatch(/FELD_/);
  });

  it('handles Word run-splitting (placeholder split across two runs)', () => {
    const zip = new PizZip(template);
    let xml = zip.file('word/document.xml')!.asText();
    xml = xml.replace(
      'Az FELD_Akte_Aktenzeichen vom FELD_Akte_LastGAVV. FELD_Schuldner_Artikel FELD_Schuldner_Schuldnerin wohnt.',
      'Az FELD_</w:t></w:r><w:r><w:t xml:space="preserve">Akte_Aktenzeichen vom FELD_Akte_LastGAVV. FELD_Schuldner_Artikel FELD_Schuldner_Schuldnerin wohnt.',
    );
    zip.file('word/document.xml', xml);
    const split = zip.generate({ type: 'nodebuffer' }) as Buffer;
    const out = generateLetterFromTemplate(split, baseResult, baseVerwalter, {});
    const text = readDocxText(out);
    expect(text).toContain('12 IN 123/24');
    expect(text).not.toContain('FELD_Akte_Aktenzeichen');
  });

  it('replaces user-input placeholders (Strafakte)', () => {
    const zip = new PizZip(template);
    let xml = zip.file('word/document.xml')!.asText();
    xml = xml.replace('als FELD_Verwalter_Art', 'wegen FELD_Strafverfahren_Tatvorwurf');
    zip.file('word/document.xml', xml);
    const custom = zip.generate({ type: 'nodebuffer' }) as Buffer;
    const out = generateLetterFromTemplate(custom, baseResult, baseVerwalter, {
      strafverfahren_tatvorwurf: 'des Betrugs',
    });
    const text = readDocxText(out);
    expect(text).toContain('wegen des Betrugs');
  });
});
