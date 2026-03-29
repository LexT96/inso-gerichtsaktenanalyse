import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult } from '../types/extraction';
import { extractSlots, fillSlots, applySlots, type GutachtenSlot, type SlotInfo } from './gutachtenSlotFiller';

// __dirname at runtime = dist/utils/ or src/utils/ — 3 levels up = project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMPLATES_DIR = path.join(PROJECT_ROOT, 'gutachtenvorlagen');
const MAPPING_PATH = path.join(TEMPLATES_DIR, 'gutachten-mapping.json');

// --- Types ---

export interface GutachtenUserInputs {
  verwalter_diktatzeichen: string;
  verwalter_geschlecht: 'maennlich' | 'weiblich';
  anderkonto_iban?: string;
  anderkonto_bank?: string;
  geschaeftsfuehrer?: string;
  last_gavv?: string;
}

export type TemplateType = 'natuerliche_person' | 'juristische_person' | 'personengesellschaft';

interface GutachtenFieldMapping {
  path?: string;
  computed?: string;
  input?: string;
}

interface GutachtenMappingFile {
  felder: Record<string, GutachtenFieldMapping>;
  templates: Record<TemplateType, string>;
  rechtsform_mapping: Record<TemplateType, string[]>;
}

const XML_PARTS = [
  'word/document.xml', 'word/header1.xml', 'word/header2.xml',
  'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml',
];

// --- Utility: getByPath (same logic as docxGenerator.ts) ---

function getByPath(obj: unknown, dotPath: string): string {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return '';
    }
  }
  return current != null ? String(current) : '';
}

// --- Utility: XML escaping ---

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// --- Template type determination ---

function loadMapping(): GutachtenMappingFile {
  return JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8')) as GutachtenMappingFile;
}

export function determineTemplateType(rechtsform: string): TemplateType {
  const mapping = loadMapping();
  const rf = (rechtsform || '').trim().toLowerCase();

  // Empty rechtsform → natuerliche_person
  if (!rf) return 'natuerliche_person';

  // Check each category; use case-insensitive substring matching
  // Collect all form→type entries and sort by form length (longest first)
  // to avoid "KG" matching before "GmbH & Co. KG"
  const allEntries: { form: string; type: TemplateType }[] = [];
  for (const [type, forms] of Object.entries(mapping.rechtsform_mapping) as [TemplateType, string[]][]) {
    for (const form of forms) {
      if (!form) continue; // Skip empty strings (natuerliche_person default)
      allEntries.push({ form, type });
    }
  }
  allEntries.sort((a, b) => b.form.length - a.form.length);

  for (const { form, type } of allEntries) {
    if (rf.includes(form.toLowerCase())) {
      return type;
    }
  }

  // Default fallback
  return 'natuerliche_person';
}

// --- Computed fields ---

function isJuristischeOderGesellschaft(result: ExtractionResult): boolean {
  const rechtsform = getByPath(result, 'schuldner.rechtsform.wert').toLowerCase();
  const templateType = determineTemplateType(rechtsform);
  return templateType === 'juristische_person' || templateType === 'personengesellschaft';
}

function getSchuldnerGeschlecht(result: ExtractionResult): string {
  return getByPath(result, 'schuldner.geschlecht.wert').toLowerCase();
}

function isSchuldnerWeiblich(result: ExtractionResult): boolean {
  const g = getSchuldnerGeschlecht(result);
  return g === 'weiblich' || g === 'w';
}

function computeGutachtenField(
  key: string,
  result: ExtractionResult,
  inputs: GutachtenUserInputs
): string {
  const weiblichVerwalter = inputs.verwalter_geschlecht === 'weiblich';
  const weiblichSchuldner = isSchuldnerWeiblich(result);
  const juristischOderGesellschaft = isJuristischeOderGesellschaft(result);

  switch (key) {
    // --- Akte ---
    case 'akte_bezeichnung': {
      const firma = getByPath(result, 'schuldner.firma.wert');
      if (firma) return `Insolvenzverfahren ${firma}`;
      const name = getByPath(result, 'schuldner.name.wert');
      const vorname = getByPath(result, 'schuldner.vorname.wert');
      if (name && vorname) return `Insolvenzverfahren ${name}, ${vorname}`;
      if (name) return `Insolvenzverfahren ${name}`;
      return 'Insolvenzverfahren';
    }

    // --- Gericht ---
    case 'gericht_ort': {
      const gericht = getByPath(result, 'verfahrensdaten.gericht.wert');
      // Extract city: "Amtsgericht Hamburg" → "Hamburg", "AG Köln" → "Köln"
      const parts = gericht.split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : gericht;
    }

    // --- Schuldner ---
    case 'schuldner_adresse': {
      const adresse = getByPath(result, 'schuldner.aktuelle_adresse.wert');
      if (adresse) return adresse;
      return getByPath(result, 'schuldner.betriebsstaette_adresse.wert');
    }

    case 'schuldner_artikel':
      // jur. Person / Gesellschaft → always "der" (Genitiv der Schuldnerin)
      // natürliche Person → gender-based
      if (juristischOderGesellschaft) return 'der';
      return weiblichSchuldner ? 'die' : 'der';

    case 'schuldner_der_die':
      if (juristischOderGesellschaft) return 'die';
      return weiblichSchuldner ? 'die' : 'der';

    case 'schuldner_der_die_gross':
      if (juristischOderGesellschaft) return 'Die';
      return weiblichSchuldner ? 'Die' : 'Der';

    case 'schuldner_schuldnerin':
      if (juristischOderGesellschaft) return 'Schuldnerin';
      return weiblichSchuldner ? 'Schuldnerin' : 'Schuldner';

    case 'schuldners_schuldnerin':
      if (juristischOderGesellschaft) return 'Schuldnerin';
      return weiblichSchuldner ? 'Schuldnerin' : 'Schuldners';

    // --- Verwalter gender variants ---
    case 'verwalter_der_die_gross':
      return weiblichVerwalter ? 'Die' : 'Der';

    case 'verwalter_der_die':
      return weiblichVerwalter ? 'die' : 'der';

    case 'verwalter_dem_der':
      return weiblichVerwalter ? 'der' : 'dem';

    case 'verwalter_den_die':
      return weiblichVerwalter ? 'die' : 'den';

    case 'verwalter_des_der':
      return weiblichVerwalter ? 'der' : 'des';

    case 'verwalter_des':
      return weiblichVerwalter ? 'der' : 'des';

    case 'verwalter_zum':
      return weiblichVerwalter ? 'zur' : 'zum';

    case 'verwalter_zum_zur':
      return weiblichVerwalter ? 'zur' : 'zum';

    case 'verwalter_unterzeichner_genitiv':
      return weiblichVerwalter ? 'Unterzeichnerin' : 'Unterzeichners';

    default:
      return '';
  }
}

// --- Build replacement map ---

export function buildReplacements(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs
): Record<string, string> {
  const mapping = loadMapping();
  const replacements: Record<string, string> = {};

  for (const [feld, def] of Object.entries(mapping.felder)) {
    if (def.path) {
      replacements[feld] = getByPath(result, def.path);
    } else if (def.computed) {
      replacements[feld] = computeGutachtenField(def.computed, result, userInputs);
    } else if (def.input) {
      const inputKey = def.input as keyof GutachtenUserInputs;
      replacements[feld] = (userInputs[inputKey] as string) ?? '';
    }
  }

  return replacements;
}

// --- Reusable DOCX paragraph processor (handles Word run-splitting) ---

export function processDocxParagraphs(
  xml: string,
  shouldProcess: (fullText: string) => boolean,
  transformFn: (fullText: string) => string
): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const textParts: { full: string; text: string }[] = [];
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let match;
    while ((match = tRegex.exec(paragraph)) !== null) {
      textParts.push({ full: match[0], text: match[1] });
    }

    if (textParts.length === 0) return paragraph;

    const fullText = textParts.map(p => p.text).join('');

    if (!shouldProcess(fullText)) return paragraph;

    const replaced = transformFn(fullText);

    let result = paragraph;
    let firstDone = false;
    for (const part of textParts) {
      if (!firstDone) {
        result = result.replace(
          part.full,
          () => `<w:t xml:space="preserve">${escapeXml(replaced)}</w:t>`
        );
        firstDone = true;
      } else {
        result = result.replace(part.full, () => '<w:t></w:t>');
      }
    }

    return result;
  });
}

// --- XML field replacement (handles Word run-splitting) ---

function replaceFieldsInXml(xml: string, replacements: Record<string, string>): string {
  const sortedKeys = Object.keys(replacements).sort((a, b) => b.length - a.length);

  return processDocxParagraphs(
    xml,
    (text) => text.includes('FELD_'),
    (text) => {
      let replaced = text;
      for (const key of sortedKeys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped + '(?:_\\d+)?', 'g');
        replaced = replaced.replace(regex, replacements[key] ?? '');
      }
      replaced = replaced.replace(/FELD_[\w\u00C0-\u024F]+/g, '');
      return replaced;
    }
  );
}

// --- Shared: load and prepare template ZIP with FELD_* replaced ---

function loadAndPrepareTemplate(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs
): { zip: PizZip; templateType: TemplateType; replacements: Record<string, string> } {
  const mapping = loadMapping();
  const rechtsform = getByPath(result, 'schuldner.rechtsform.wert');
  const templateType = determineTemplateType(rechtsform);
  const templateFilename = mapping.templates[templateType];

  if (!templateFilename) throw new Error(`Kein Template für Typ: ${templateType}`);

  const templatePath = path.resolve(TEMPLATES_DIR, templateFilename);
  if (!templatePath.startsWith(TEMPLATES_DIR)) throw new Error(`Ungültiger Template-Pfad: ${templateFilename}`);
  if (!fs.existsSync(templatePath)) throw new Error(`Template nicht gefunden: ${templateFilename}`);

  const replacements = buildReplacements(result, userInputs);
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);

  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const xmlContent = file.asText();
    zip.file(partName, replaceFieldsInXml(xmlContent, replacements));
  }

  return { zip, templateType, replacements };
}

// --- Prepare: extract slots and fill via Claude ---

export async function prepareGutachten(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs
): Promise<{ templateType: TemplateType; slots: GutachtenSlot[]; feldValues: Record<string, string> }> {
  const { zip, templateType, replacements } = loadAndPrepareTemplate(result, userInputs);

  let allSlots: SlotInfo[] = [];
  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const { slots } = extractSlots(file.asText());
    allSlots = allSlots.concat(slots);
  }

  const filledSlots = await fillSlots(allSlots, result);

  return { templateType, slots: filledSlots, feldValues: replacements };
}

// --- Generate: apply final slot values and return DOCX buffer ---

export function generateGutachtenFinal(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs,
  finalSlots: { id: string; value: string }[]
): Buffer {
  const { zip } = loadAndPrepareTemplate(result, userInputs);

  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const { xml: slottedXml } = extractSlots(file.asText());
    const finalXml = applySlots(slottedXml, finalSlots);
    zip.file(partName, finalXml);
  }

  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
