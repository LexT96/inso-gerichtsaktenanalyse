import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import { schuldnerGender, verwalterGender, type GenderInput } from './genderHelpers';

// Inlined XML helpers (mirrors gutachtenGenerator.ts) — avoids transitive
// config.ts import chain that process.exit(1)s during tests without env vars.
// TODO: extract into `backend/src/utils/docxXml.ts` so this + gutachtenGenerator
// share a single source of truth. (Not in scope for Task 4.)

function escapeXml(str: string): string {
  const unescaped = str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"');
  return unescaped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"');
}

// Flatten a paragraph-XML fragment (or any XML chunk containing <w:t> elements)
// into its first <w:t> after running transformFn on the concatenated text.
// Other <w:t>s are emptied. Structural elements (<w:tab/>, <w:br/>) live
// outside <w:t> and are not touched by the regex below — callers that need
// to preserve tab positions should split on <w:tab/> BEFORE calling this.
function flattenAndReplace(
  chunk: string,
  shouldProcess: (fullText: string) => boolean,
  transformFn: (fullText: string) => string,
): string {
  const textParts: { full: string; text: string }[] = [];
  const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let match;
  while ((match = tRegex.exec(chunk)) !== null) {
    textParts.push({ full: match[0], text: match[1] });
  }
  if (textParts.length === 0) return chunk;
  const fullText = textParts.map(p => p.text).join('');
  if (!shouldProcess(fullText)) return chunk;
  const replaced = transformFn(fullText);
  let result = chunk;
  let firstDone = false;
  for (const part of textParts) {
    if (!firstDone) {
      result = result.replace(
        part.full,
        () => `<w:t xml:space="preserve">${escapeXml(unescapeXmlEntities(replaced))}</w:t>`,
      );
      firstDone = true;
    } else {
      result = result.replace(part.full, () => '<w:t></w:t>');
    }
  }
  return result;
}

function processDocxParagraphs(
  xml: string,
  shouldProcess: (fullText: string) => boolean,
  transformFn: (fullText: string) => string,
): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    // If the paragraph contains tabs/line-breaks, process each tab-separated
    // segment independently so the structural elements keep their positions.
    const SPLIT_RE = /<w:tab\s*\/>|<w:br\s*\/>/g;
    if (SPLIT_RE.test(paragraph)) {
      SPLIT_RE.lastIndex = 0;
      const pieces: string[] = [];
      const separators: string[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = SPLIT_RE.exec(paragraph)) !== null) {
        pieces.push(paragraph.slice(last, m.index));
        separators.push(m[0]);
        last = m.index + m[0].length;
      }
      pieces.push(paragraph.slice(last));
      const processed = pieces.map((piece) => flattenAndReplace(piece, shouldProcess, transformFn));
      let out = processed[0];
      for (let i = 0; i < separators.length; i++) {
        out += separators[i] + processed[i + 1];
      }
      return out;
    }
    return flattenAndReplace(paragraph, shouldProcess, transformFn);
  });
}
import type { ExtractionResult } from '../types/extraction';

function findStandardschreibenDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'standardschreiben');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'standardschreiben');
}

const MAPPING_PATH = path.join(findStandardschreibenDir(), 'platzhalter-mapping.json');

interface FieldMapping {
  path?: string;
  computed?: string;
  verwalter?: string;
  static?: string;
  input?: string;
}

interface MappingFile {
  felder: Record<string, FieldMapping>;
}

let _mappingCache: MappingFile | null = null;
function loadMapping(): MappingFile {
  if (!_mappingCache) {
    _mappingCache = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8')) as MappingFile;
  }
  return _mappingCache;
}
export function invalidateLetterMappingCache(): void { _mappingCache = null; }

export interface LetterVerwalterProfile {
  name: string;
  art: string;
  diktatzeichen: string;
  geschlecht: 'maennlich' | 'weiblich';
}

export type LetterExtras = Record<string, string>;

function getByPath(obj: unknown, dotPath: string): string {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const p of parts) {
    if (current && typeof current === 'object' && p in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[p];
    } else {
      return '';
    }
  }
  if (current == null) return '';
  // Defensive: if the path landed on an object (e.g. mapping forgot ".wert"),
  // return empty string instead of "[object Object]".
  if (typeof current === 'object') return '';
  return String(current);
}

function computeField(
  name: string,
  result: ExtractionResult,
  verwalter: LetterVerwalterProfile,
): string {
  const schuldnerGeschlecht = getByPath(result, 'schuldner.geschlecht.wert') as GenderInput;

  switch (name) {
    case 'schuldner_der_die': return schuldnerGender(schuldnerGeschlecht, 'der_die');
    case 'schuldner_Der_Die': return schuldnerGender(schuldnerGeschlecht, 'Der_Die');
    case 'schuldner_den_die': return schuldnerGender(schuldnerGeschlecht, 'den_die');
    case 'schuldner_dem_der': return schuldnerGender(schuldnerGeschlecht, 'dem_der');
    case 'schuldner_des_der': return schuldnerGender(schuldnerGeschlecht, 'des_der');
    case 'schuldner_nominativ_substantiv': return schuldnerGender(schuldnerGeschlecht, 'nominativ_substantiv');
    case 'schuldner_genitiv_substantiv': return schuldnerGender(schuldnerGeschlecht, 'genitiv_substantiv');
    case 'schuldner_halters_halterin': return schuldnerGender(schuldnerGeschlecht, 'halters_halterin');

    case 'verwalter_der_die': return verwalterGender(verwalter.geschlecht, 'der_die');
    case 'verwalter_Der_Die': return verwalterGender(verwalter.geschlecht, 'Der_Die');
    case 'verwalter_zum_zur': return verwalterGender(verwalter.geschlecht, 'zum_zur');

    case 'schuldner_vollname': {
      const firma = getByPath(result, 'schuldner.firma.wert');
      if (firma) return firma;
      const vorname = getByPath(result, 'schuldner.vorname.wert');
      const name = getByPath(result, 'schuldner.name.wert');
      return [vorname, name].filter(Boolean).join(' ');
    }

    case 'gericht_ort': {
      const g = getByPath(result, 'verfahrensdaten.gericht.wert');
      return g.replace(/^Amtsgericht\s+/i, '').split(/\s-/)[0].trim();
    }

    case 'verfahren_art': {
      const va = getByPath(result, 'verfahrensdaten.verfahrensart.wert').toLowerCase();
      if (va.includes('antrag')) return 'Insolvenzantragsverfahren';
      return 'Insolvenzverfahren';
    }

    case 'akte_bezeichnung': {
      const az = getByPath(result, 'verfahrensdaten.aktenzeichen.wert');
      const va = computeField('verfahren_art', result, verwalter);
      return [az, va].filter(Boolean).join(', ');
    }

    case 'eroeffnungsdatum_oder_beschluss': {
      return getByPath(result, 'verfahrensdaten.eroeffnungsdatum.wert')
        || getByPath(result, 'verfahrensdaten.beschlussdatum.wert');
    }

    case 'antwort_frist': {
      // Approximates 14 Werktage by skipping Sat/Sun only — does NOT account for
      // German public holidays (Feiertage). Treat output as a default that the
      // verwalter reviews and adjusts in Word before sending.
      // TODO: replace with a proper Werktag calculator (Bundesland-aware calendar).
      const d = new Date();
      let added = 0;
      while (added < 14) {
        d.setDate(d.getDate() + 1);
        const day = d.getDay();
        if (day !== 0 && day !== 6) added++;
      }
      return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    default: return '';
  }
}

export function buildLetterReplacements(
  result: ExtractionResult,
  verwalter: LetterVerwalterProfile,
  extras: LetterExtras,
): Record<string, string> {
  const mapping = loadMapping();
  const replacements: Record<string, string> = {};

  for (const [feld, def] of Object.entries(mapping.felder)) {
    if (def.static !== undefined) {
      replacements[feld] = def.static;
    } else if (def.path) {
      replacements[feld] = getByPath(result, def.path);
    } else if (def.computed) {
      replacements[feld] = computeField(def.computed, result, verwalter);
    } else if (def.verwalter) {
      replacements[feld] = (verwalter as unknown as Record<string, string>)[def.verwalter] ?? '';
    } else if (def.input) {
      replacements[feld] = extras[def.input] ?? '';
    }
  }

  return replacements;
}

// Longest-first placeholder ordering avoids short keys shadowing longer ones.
function replaceAllPlaceholders(text: string, replacements: Record<string, string>, wipeUnmapped = true): string {
  const tokens = Object.keys(replacements).sort((a, b) => b.length - a.length);
  let out = text;
  for (const tok of tokens) {
    out = out.split(tok).join(replacements[tok] ?? '');
  }
  if (wipeUnmapped) {
    // Any remaining FELD_* (unmapped) → remove to avoid leakage
    out = out.replace(/FELD_[A-Za-zÄÖÜäöüß0-9_]+/g, '');
  }
  return out;
}

// Pass 1: replace placeholders within each individual <w:t> element, preserving
// the surrounding run's formatting (<w:rPr> stays untouched). Skips unmapped
// FELD_* so that Pass 2 can catch run-split cases.
function replacePerRunText(xml: string, replacements: Record<string, string>): string {
  return xml.replace(
    /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g,
    (_full, open: string, text: string, close: string) => {
      if (!text.includes('FELD_')) return open + text + close;
      const replaced = replaceAllPlaceholders(
        unescapeXmlEntities(text),
        replacements,
        /* wipeUnmapped */ false,
      );
      // Ensure whitespace is preserved after substitution.
      const openWithSpace = open.includes('xml:space=') ? open : open.replace('<w:t', '<w:t xml:space="preserve"');
      return openWithSpace + escapeXml(replaced) + close;
    },
  );
}

export function generateLetterFromTemplate(
  templateBuffer: Buffer,
  result: ExtractionResult,
  verwalter: LetterVerwalterProfile,
  extras: LetterExtras,
): Buffer {
  const replacements = buildLetterReplacements(result, verwalter, extras);
  const zip = new PizZip(templateBuffer);
  const docXml = zip.file('word/document.xml');
  if (!docXml) throw new Error('word/document.xml nicht gefunden — keine gültige DOCX-Datei');
  let xml = docXml.asText();

  // Pass 1: per-<w:t> replacement preserves run-level formatting (bold/italic/underline).
  xml = replacePerRunText(xml, replacements);

  // Pass 2: for any FELD_* that survived (split across runs), flatten the paragraph.
  // Formatting on the split-across-runs placeholder is lost; this is the rare case.
  xml = processDocxParagraphs(
    xml,
    (fullText) => fullText.includes('FELD_'),
    (fullText) => replaceAllPlaceholders(fullText, replacements),
  );

  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
