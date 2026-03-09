import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult } from '../types/extraction';

const TEMPLATES_DIR = path.resolve(process.cwd(), 'standardschreiben');
const MAPPING_PATH = path.join(TEMPLATES_DIR, 'platzhalter-mapping.json');

interface FieldMapping {
  path?: string;
  computed?: string;
  static?: string;
}

interface MappingFile {
  felder: Record<string, FieldMapping>;
}

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

function computeField(key: string, result: ExtractionResult): string {
  const geschlecht = getByPath(result, 'schuldner.geschlecht.wert').toLowerCase();
  const weiblich = geschlecht === 'weiblich' || geschlecht === 'w';

  switch (key) {
    case 'geschlecht_artikel':  return weiblich ? 'die' : 'der';
    case 'geschlecht_der_die':  return weiblich ? 'die' : 'der';
    case 'geschlecht_genitiv':  return weiblich ? 'Schuldnerin' : 'Schuldners';
    case 'verwalter_kuerzel': {
      const name = getByPath(result, 'antragsteller.name.wert');
      const parts = name.split(' ').filter(Boolean);
      return parts.map((p: string) => p[0]?.toUpperCase() ?? '').join('');
    }
    default: return '';
  }
}

export function generateDocx(templateFilename: string, result: ExtractionResult): Buffer {
  const templatePath = path.join(TEMPLATES_DIR, templateFilename);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template nicht gefunden: ${templateFilename}`);
  }

  const mapping: MappingFile = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8'));
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
  });

  const data: Record<string, string> = {};
  for (const [feld, def] of Object.entries(mapping.felder)) {
    if (def.static) {
      data[feld] = def.static;
    } else if (def.path) {
      data[feld] = getByPath(result, def.path);
    } else if (def.computed) {
      data[feld] = computeField(def.computed, result);
    }
  }

  doc.render(data);

  return doc.getZip().generate({ type: 'nodebuffer' }) as Buffer;
}
