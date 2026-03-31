import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult } from '../types/extraction';
import { extractSlots, fillSlots, applySlots, type GutachtenSlot, type SlotInfo } from './gutachtenSlotFiller';

// __dirname at runtime = dist/utils/ or src/utils/ — 3 levels up = project root
const TEMPLATES_DIR = path.resolve(process.cwd(), 'gutachtenvorlagen');
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

export function formatEUR(value: unknown, includeSuffix = true): string {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (isNaN(n) || value == null) return '';
  const formatted = n.toLocaleString('de-DE', { minimumFractionDigits: 2 });
  return includeSuffix ? formatted + ' EUR' : formatted;
}

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

const GUETERSTAND_LABELS: Record<string, string> = {
  zugewinngemeinschaft: 'Zugewinngemeinschaft',
  guetertrennung: 'Gütertrennung',
  guetergemeinschaft: 'Gütergemeinschaft',
  unbekannt: 'unbekannt',
};

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
      // Used on cover page — just the Schuldner name/firma, no "Insolvenzverfahren" prefix
      // (the template already has "Insolvenzantragsverfahren über das Vermögen...")
      const firma = getByPath(result, 'schuldner.firma.wert');
      const name = getByPath(result, 'schuldner.name.wert');
      const vorname = getByPath(result, 'schuldner.vorname.wert');
      if (firma) {
        // For entities: "Pizza Kebaphaus Alt Ehrang" or "coboworx GmbH"
        return firma;
      }
      // For natural persons: "Bayar, Mehmet" (Nachname, Vorname)
      if (name && vorname) return `${name}, ${vorname}`;
      if (name) return name;
      return '';
    }

    // --- Gericht ---
    case 'gericht_ort': {
      const gericht = getByPath(result, 'verfahrensdaten.gericht.wert');
      const parts = gericht.split(/\s+/);
      return parts.length > 1 ? parts.slice(1).join(' ') : gericht;
    }

    // --- Schuldner ---
    case 'schuldner_adresse': {
      const adresse = getByPath(result, 'schuldner.aktuelle_adresse.wert');
      if (adresse) return adresse;
      return getByPath(result, 'schuldner.betriebsstaette_adresse.wert');
    }

    case 'schuldner_name_vorname': {
      if (juristischOderGesellschaft) {
        const firma = getByPath(result, 'schuldner.firma.wert');
        const rf = getByPath(result, 'schuldner.rechtsform.wert');
        return firma ? (rf ? `${firma} ${rf}` : firma) : '';
      }
      const name = getByPath(result, 'schuldner.name.wert');
      const vorname = getByPath(result, 'schuldner.vorname.wert');
      if (name && vorname) return `${vorname} ${name}`;
      return name || '';
    }

    case 'schuldner_geburtsdaten': {
      if (juristischOderGesellschaft) return '';
      const geb = getByPath(result, 'schuldner.geburtsdatum.wert');
      const ort = getByPath(result, 'schuldner.geburtsort.wert');
      if (!geb) return '';
      return ort ? `geb. ${geb} in ${ort}` : `geb. ${geb}`;
    }

    case 'schuldner_artikel':
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

    // --- Ehegatte (nur natürliche Person) ---
    case 'ehegatte_name':
      if (juristischOderGesellschaft) return '';
      return getByPath(result, 'schuldner.ehegatte.name.wert');

    case 'ehegatte_geburtsdatum':
      if (juristischOderGesellschaft) return '';
      return getByPath(result, 'schuldner.ehegatte.geburtsdatum.wert');

    case 'ehegatte_gueterstand': {
      if (juristischOderGesellschaft) return '';
      const gs = result.schuldner?.ehegatte?.gueterstand;
      return gs ? (GUETERSTAND_LABELS[gs] || gs) : '';
    }

    // --- Beschäftigung (nur natürliche Person) ---
    case 'beschaeftigung_arbeitgeber':
      if (juristischOderGesellschaft) return '';
      return getByPath(result, 'schuldner.beschaeftigung.arbeitgeber.wert');

    case 'beschaeftigung_einkommen':
      if (juristischOderGesellschaft) return '';
      return formatEUR(result.schuldner?.beschaeftigung?.nettoeinkommen?.wert);

    case 'beschaeftigung_art':
      if (juristischOderGesellschaft) return '';
      return getByPath(result, 'schuldner.beschaeftigung.art.wert');

    case 'pfaendbarer_betrag':
      if (juristischOderGesellschaft) return '';
      return formatEUR(result.schuldner?.pfaendungsberechnung?.pfaendbarer_betrag?.wert);

    case 'unterhaltspflichten': {
      if (juristischOderGesellschaft) return '';
      const u = result.schuldner?.pfaendungsberechnung?.unterhaltspflichten?.wert;
      return u != null ? String(u) : '';
    }

    // --- Forderungen ---
    case 'forderungen_gesamt':
      return formatEUR(result.forderungen?.gesamtforderungen?.wert);

    case 'forderungen_gesichert':
      return formatEUR(result.forderungen?.gesicherte_forderungen?.wert);

    case 'forderungen_ungesichert':
      return formatEUR(result.forderungen?.ungesicherte_forderungen?.wert);

    case 'anzahl_glaeubiger': {
      const n = result.forderungen?.einzelforderungen?.length ?? 0;
      return n > 0 ? String(n) : '';
    }

    // --- Aktiva ---
    case 'aktiva_summe':
      return formatEUR(result.aktiva?.summe_aktiva?.wert);

    case 'aktiva_massekosten':
      return formatEUR(result.aktiva?.massekosten_schaetzung?.wert);

    // --- Anfechtung ---
    case 'anfechtung_potenzial':
      return formatEUR(result.anfechtung?.gesamtpotenzial?.wert);

    // --- Table cell fields (new) ---
    case 'arbeitnehmer_anzahl': {
      const an = result.forderungen?.betroffene_arbeitnehmer;
      if (an?.length) {
        const total = an.reduce((s: number, a: unknown) => {
          if (a && typeof a === 'object' && 'anzahl' in a) return s + ((a as { anzahl: number }).anzahl || 0);
          return s;
        }, 0);
        if (total > 0) return String(total);
      }
      return '';
    }

    case 'finanzamt':
    case 'steuernummer':
    case 'letzter_jahresabschluss':
    case 'steuerberater':
    case 'gerichtsvollzieher':
    case 'sv_traeger':
    case 'ausbildung':
    case 'groessenklasse':
    case 'gruendung':
    case 'gesellschafter': {
      // These are extracted by the ermittlungsergebnisse or zusammenfassung
      // Search zusammenfassung for relevant info
      const zf = result.zusammenfassung ?? [];
      const keywords: Record<string, RegExp> = {
        finanzamt: /finanzamt/i,
        steuernummer: /steuer.?n/i,
        letzter_jahresabschluss: /jahresabschluss|bilanz/i,
        steuerberater: /steuerberater/i,
        gerichtsvollzieher: /gerichtsvollzieher/i,
        sv_traeger: /sozialversicherung|krankenkasse/i,
        ausbildung: /ausbildung|beruf/i,
        groessenklasse: /gr.{0,3}.enklasse|267.*hgb/i,
        gruendung: /gr.{0,3}ndung|gegr.{0,3}ndet/i,
        gesellschafter: /gesellschafter|anteilseigner/i,
      };
      const kw = keywords[key];
      if (kw) {
        // Search ermittlungsergebnisse fields
        const erm = result.ermittlungsergebnisse as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(erm || {})) {
          if (kw.test(k) && v && typeof v === 'object' && 'wert' in v) {
            const val = (v as { wert: unknown }).wert;
            if (val != null && val !== '') return String(val);
          }
        }
        // Search zusammenfassung
        for (const z of zf) {
          if (z.wert && kw.test(z.wert)) {
            // Extract the relevant part
            return z.wert.length > 80 ? z.wert.slice(0, 80) + '…' : z.wert;
          }
        }
      }
      return '';
    }

    case 'bankverbindungen': {
      const iban = getByPath(result, 'antragsteller.bankverbindung_iban.wert');
      const bic = getByPath(result, 'antragsteller.bankverbindung_bic.wert');
      if (iban) return bic ? `${iban} (BIC: ${bic})` : iban;
      return '';
    }

    case 'aelteste_forderung': {
      const ef = result.forderungen?.einzelforderungen ?? [];
      if (ef.length === 0) return '';
      // Find earliest zeitraum_von
      let earliest = '';
      for (const f of ef) {
        const von = f.zeitraum_von?.wert;
        if (von && (!earliest || von < earliest)) earliest = von;
      }
      return earliest || '';
    }

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

// --- Dynamic table generation (Tier 2: deterministic, no AI) ---

const ART_LABELS: Record<string, string> = {
  sozialversicherung: 'Sozialversicherung',
  steuer: 'Steuerforderungen',
  bank: 'Bankforderungen',
  lieferant: 'Lieferantenforderungen',
  arbeitnehmer: 'Arbeitnehmerforderungen',
  miete: 'Mietforderungen',
  sonstige: 'Sonstige Forderungen',
};

const KATEGORIE_LABELS: Record<string, string> = {
  immobilien: 'Immobilien',
  fahrzeuge: 'Fahrzeuge',
  bankguthaben: 'Bankguthaben',
  lebensversicherungen: 'Lebensversicherungen',
  wertpapiere_beteiligungen: 'Wertpapiere/Beteiligungen',
  forderungen_schuldner: 'Forderungen des Schuldners',
  bewegliches_vermoegen: 'Bewegliches Vermögen',
  geschaeftsausstattung: 'Geschäftsausstattung',
  steuererstattungen: 'Steuererstattungen',
  einkommen: 'Einkommen',
};

function tblCell(text: string, opts?: { bold?: boolean; rightAlign?: boolean; width?: number; shading?: string }): string {
  const tcPr: string[] = [];
  if (opts?.width) tcPr.push(`<w:tcW w:w="${opts.width}" w:type="pct"/>`);
  if (opts?.shading) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shading}"/>`);
  const rPr: string[] = ['<w:sz w:val="18"/><w:szCs w:val="18"/>'];
  if (opts?.bold) rPr.push('<w:b/><w:bCs/>');
  const pPr = opts?.rightAlign ? '<w:pPr><w:jc w:val="right"/></w:pPr>' : '';
  return `<w:tc>${tcPr.length ? `<w:tcPr>${tcPr.join('')}</w:tcPr>` : ''}<w:p>${pPr}<w:r><w:rPr>${rPr.join('')}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:tc>`;
}

function tblRow(cells: string[], isHeader = false): string {
  const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
  return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
}

const TBL_BORDERS = `<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="2" w:space="0" w:color="CCCCCC"/><w:insideV w:val="single" w:sz="2" w:space="0" w:color="CCCCCC"/></w:tblBorders>`;

function wrapTable(rows: string[]): string {
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${TBL_BORDERS}<w:tblLook w:val="04A0"/></w:tblPr>${rows.join('')}</w:tbl>`;
}

function safeNum(val: unknown): number {
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isNaN(n) ? 0 : n;
}

function buildGlaeubigerTable(result: ExtractionResult): string {
  const ef = result.forderungen?.einzelforderungen ?? [];
  if (ef.length === 0) return '';

  const rows: string[] = [];
  rows.push(tblRow([
    tblCell('Nr.', { bold: true, width: 350, shading: 'F2F2F2' }),
    tblCell('Gläubiger', { bold: true, width: 1500, shading: 'F2F2F2' }),
    tblCell('Art / Rechtsgrund', { bold: true, width: 1500, shading: 'F2F2F2' }),
    tblCell('Betrag', { bold: true, rightAlign: true, width: 800, shading: 'F2F2F2' }),
    tblCell('Rang', { bold: true, width: 450, shading: 'F2F2F2' }),
  ], true));

  const grouped = new Map<string, typeof ef>();
  for (const f of ef) {
    const list = grouped.get(f.art) || [];
    list.push(f);
    grouped.set(f.art, list);
  }

  let nr = 0;
  for (const [art, items] of grouped) {
    rows.push(tblRow([
      tblCell('', { shading: 'F7F7F7' }),
      tblCell(ART_LABELS[art] || art, { bold: true, shading: 'F7F7F7' }),
      tblCell(`(${items.length})`, { shading: 'F7F7F7' }),
      tblCell('', { shading: 'F7F7F7' }),
      tblCell('', { shading: 'F7F7F7' }),
    ]));

    for (const f of items) {
      nr++;
      const betrag = safeNum(f.betrag?.wert);
      const rang = String(f.rang || '§38').replace(/\s.*/, '');
      const titel = f.titel?.wert || '';
      const sicherheit = f.sicherheit ? ` [${f.sicherheit.art}]` : '';
      rows.push(tblRow([
        tblCell(String(nr)),
        tblCell(String(f.glaeubiger?.wert || '\u2014')),
        tblCell(titel + sicherheit),
        tblCell(betrag > 0 ? formatEUR(betrag) : '\u2014', { rightAlign: true }),
        tblCell(rang),
      ]));
    }

    if (items.length > 1) {
      const sub = items.reduce((s, f) => s + safeNum(f.betrag?.wert), 0);
      rows.push(tblRow([
        tblCell(''), tblCell(''),
        tblCell('Zwischensumme', { bold: true }),
        tblCell(formatEUR(sub), { bold: true, rightAlign: true }),
        tblCell(''),
      ]));
    }
  }

  const gesamt = result.forderungen?.gesamtforderungen?.wert;
  const total = gesamt != null ? formatEUR(gesamt) : formatEUR(
    ef.reduce((s, f) => s + safeNum(f.betrag?.wert), 0)
  );
  rows.push(tblRow([
    tblCell('', { shading: 'E8E8E8' }), tblCell('', { shading: 'E8E8E8' }),
    tblCell('GESAMTFORDERUNGEN', { bold: true, shading: 'E8E8E8' }),
    tblCell(total, { bold: true, rightAlign: true, shading: 'E8E8E8' }),
    tblCell('', { shading: 'E8E8E8' }),
  ]));

  return wrapTable(rows);
}

function buildAktivaTable(result: ExtractionResult): string {
  const positionen = result.aktiva?.positionen ?? [];
  if (positionen.length === 0) return '';

  const rows: string[] = [];
  rows.push(tblRow([
    tblCell('Kategorie', { bold: true, width: 1200, shading: 'F2F2F2' }),
    tblCell('Beschreibung', { bold: true, width: 2500, shading: 'F2F2F2' }),
    tblCell('Geschätzter Wert', { bold: true, rightAlign: true, width: 1000, shading: 'F2F2F2' }),
  ], true));

  const grouped = new Map<string, typeof positionen>();
  for (const p of positionen) {
    const list = grouped.get(p.kategorie) || [];
    list.push(p);
    grouped.set(p.kategorie, list);
  }

  for (const [kat, items] of grouped) {
    for (const p of items) {
      const wert = safeNum(p.geschaetzter_wert?.wert);
      rows.push(tblRow([
        tblCell(KATEGORIE_LABELS[kat] || kat),
        tblCell(String(p.beschreibung?.wert || '\u2014')),
        tblCell(wert > 0 ? formatEUR(wert) : '\u2014', { rightAlign: true }),
      ]));
    }
  }

  const summe = result.aktiva?.summe_aktiva?.wert;
  const total = summe != null ? formatEUR(summe) : formatEUR(
    positionen.reduce((s, p) => s + safeNum(p.geschaetzter_wert?.wert), 0)
  );
  rows.push(tblRow([
    tblCell('', { shading: 'E8E8E8' }),
    tblCell('SUMME AKTIVA', { bold: true, shading: 'E8E8E8' }),
    tblCell(total, { bold: true, rightAlign: true, shading: 'E8E8E8' }),
  ]));

  const mk = result.aktiva?.massekosten_schaetzung?.wert;
  if (mk != null) {
    rows.push(tblRow([
      tblCell(''), tblCell('Geschätzte Massekosten (§ 54 InsO)'),
      tblCell(formatEUR(mk), { rightAlign: true }),
    ]));
    const netto = safeNum(summe) - safeNum(mk);
    rows.push(tblRow([
      tblCell('', { shading: 'E8E8E8' }),
      tblCell('FREIE MASSE', { bold: true, shading: 'E8E8E8' }),
      tblCell(formatEUR(netto), { bold: true, rightAlign: true, shading: 'E8E8E8' }),
    ]));
  }

  return wrapTable(rows);
}

function buildAnfechtungTable(result: ExtractionResult): string {
  const vorgaenge = result.anfechtung?.vorgaenge ?? [];
  if (vorgaenge.length === 0) return '';

  const rows: string[] = [];
  rows.push(tblRow([
    tblCell('Datum', { bold: true, width: 600, shading: 'F2F2F2' }),
    tblCell('Beschreibung', { bold: true, width: 1700, shading: 'F2F2F2' }),
    tblCell('Betrag', { bold: true, rightAlign: true, width: 700, shading: 'F2F2F2' }),
    tblCell('Empfänger', { bold: true, width: 900, shading: 'F2F2F2' }),
    tblCell('Grundlage', { bold: true, width: 600, shading: 'F2F2F2' }),
    tblCell('Risiko', { bold: true, width: 500, shading: 'F2F2F2' }),
  ], true));

  for (const v of vorgaenge) {
    const betrag = safeNum(v.betrag?.wert);
    const grundlage = String(v.grundlage || '').split(' ').slice(0, 2).join(' ');
    rows.push(tblRow([
      tblCell(String(v.datum?.wert || '\u2014')),
      tblCell(String(v.beschreibung?.wert || '\u2014')),
      tblCell(betrag > 0 ? formatEUR(betrag) : '\u2014', { rightAlign: true }),
      tblCell(String(v.empfaenger?.wert || '\u2014')),
      tblCell(grundlage),
      tblCell(String(v.risiko || '\u2014')),
    ]));
  }

  const gesamt = result.anfechtung?.gesamtpotenzial?.wert;
  const total = gesamt != null ? formatEUR(gesamt) : formatEUR(
    vorgaenge.reduce((s, v) => s + safeNum(v.betrag?.wert), 0)
  );
  rows.push(tblRow([
    tblCell('', { shading: 'E8E8E8' }),
    tblCell('ANFECHTUNGSPOTENZIAL', { bold: true, shading: 'E8E8E8' }),
    tblCell(total, { bold: true, rightAlign: true, shading: 'E8E8E8' }),
    tblCell('', { shading: 'E8E8E8' }),
    tblCell('', { shading: 'E8E8E8' }),
    tblCell('', { shading: 'E8E8E8' }),
  ]));

  return wrapTable(rows);
}

const TABLE_PATTERNS: { pattern: RegExp; builder: (r: ExtractionResult) => string }[] = [
  { pattern: /\[(?:Tabelle[:\s]*)?Gl.{0,10}ubiger/i, builder: buildGlaeubigerTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Forderung/i, builder: buildGlaeubigerTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Aktiva/i, builder: buildAktivaTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Verm.{0,10}gen/i, builder: buildAktivaTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Anfechtung/i, builder: buildAnfechtungTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Anfechtbar/i, builder: buildAnfechtungTable },
];

function injectDynamicTables(xml: string, result: ExtractionResult): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let fullText = '';
    let m;
    while ((m = tRegex.exec(paragraph)) !== null) fullText += m[1];
    if (!fullText.trim()) return paragraph;

    for (const { pattern, builder } of TABLE_PATTERNS) {
      if (pattern.test(fullText)) {
        const table = builder(result);
        if (table) return table;
      }
    }
    return paragraph;
  });
}

// --- Comment-based editorial rules ---
// Implements instructions from Word comments in the templates:
// #0: "Bericht nur wenn vorl. Verwalter" → Title adaptation
// #29: Internal process note → skip (not relevant for generation)
// #58: "Streichen wenn Bezug zu Mitgliedsstaat" → Remove EuInsVO detail section
// #61: "Entfernen wenn keine selbstständige Tätigkeit" → Adapt örtl. Zuständigkeit

function isVorlaeufigverwalter(result: ExtractionResult): boolean {
  const befugnisse = result.gutachterbestellung?.befugnisse ?? [];
  return befugnisse.some(b =>
    /vorl.{0,5}ufig.*insolvenzverwalter|vorl.{0,5}ufig.*verwalter/i.test(b)
  );
}

function hasSelbststaendigeTaetigkeit(result: ExtractionResult): boolean {
  // If there's a Betriebsstätte or Firma, they have a business
  const firma = result.schuldner?.firma?.wert;
  const betrieb = result.schuldner?.betriebsstaette_adresse?.wert;
  return Boolean(firma || betrieb);
}

function hasInternationalerBezug(result: ExtractionResult): boolean {
  // Check for non-German nationality or foreign addresses
  const staat = String(result.schuldner?.staatsangehoerigkeit?.wert || '').toLowerCase();
  if (staat && staat !== 'deutsch' && staat !== 'deutschland' && staat !== 'german') return true;
  const geburtsland = String(result.schuldner?.geburtsland?.wert || '').toLowerCase();
  if (geburtsland && geburtsland !== 'deutschland' && geburtsland !== 'germany' && geburtsland !== 'de') return true;
  return false;
}

function applyCommentRules(xml: string, result: ExtractionResult): string {
  const isVorlIV = isVorlaeufigverwalter(result);
  const hatSelbststaendig = hasSelbststaendigeTaetigkeit(result);
  const hatInternational = hasInternationalerBezug(result);

  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let fullText = '';
    let m;
    while ((m = tRegex.exec(paragraph)) !== null) fullText += m[1];
    const text = fullText.trim();
    const lower = text.toLowerCase();

    // Rule #0: "Gutachten und Bericht" → "Gutachten" if only Sachverständiger
    if (!isVorlIV && /^gutachten und bericht$/i.test(text)) {
      return paragraph.replace(/Gutachten und Bericht/i, 'Gutachten');
    }

    // Rule #0b: Remove "und erstattet hiermit Bericht..." if only Sachverständiger
    if (!isVorlIV && lower.includes('erstattet hiermit bericht')) {
      return paragraph.replace(
        /und erstattet hiermit Bericht über den Verlauf des Antragsverfahrens:/i,
        ':'
      );
    }

    // Rule #58: Remove detailed EuInsVO explanation if no international connection
    // Keep the conclusion ("Gem. Art. 3 Abs. 1 EuInsVO sind deutsche Gerichte...zuständig")
    // but remove the lengthy legal explanation (paragraphs starting with "Zur Bestimmung",
    // "Die Norm regelt", "Nach Art. 3 Abs. 1 EuInsVO", "Der COMI ist", "Bei einer natürlichen Person")
    if (!hatInternational) {
      if (/^zur bestimmung der internationalen zuständigkeit/i.test(lower) ||
          /^die norm regelt/i.test(lower) ||
          /^nach art\. 3 abs\. 1 euinsvo sind für die eröffnung/i.test(lower) ||
          /^der comi ist/i.test(lower) ||
          /^bei einer natürlichen person.*euinsvo/i.test(lower) ||
          /^bei einer gesellschaft.*euinsvo/i.test(lower) ||
          /^insofern hat das deutsche internationale/i.test(lower)) {
        return ''; // Remove paragraph
      }
    }

    // Rule #61: If no selbstständige Tätigkeit, remove the paragraph about
    // "Mittelpunkt der selbstständigen wirtschaftlichen Tätigkeit"
    // and keep the general Gerichtsstand variant
    if (!hatSelbststaendig) {
      if (/^die bestimmung der örtlichen zuständigkeit richtet sich gem\. § 3 abs\. 1 s\. 2/i.test(lower) ||
          /^der mittelpunkt der selbstständigen tätigkeit/i.test(lower)) {
        return ''; // Remove paragraph - falls back to general Gerichtsstand
      }
    }

    // Rule: Remove "als Sachverständiger und vorläufiger Insolvenzverwalter" → just Sachverständiger
    if (!isVorlIV && /als sachverständige.*und vorl.*insolvenzverwalter/i.test(lower)) {
      return paragraph.replace(
        /als Sachverständige[r]? und vorläufige[r]? Insolvenzverwalter(in)?/gi,
        'als Sachverständiger'
      );
    }

    return paragraph;
  });
}

// --- Conditional section removal ---

const NATUERLICHE_PERSON_SECTION_KW = [
  'ehegatte', 'ehefrau', 'ehemann', 'lebenspartner',
  'beschäftigung', 'beschaeftigung', 'arbeitgeber', 'nettoeinkommen',
  'pfändung', 'pfaendung', 'pfändbarer', 'pfaendbarer',
  'unterhaltspflicht', 'familienstand',
];

const JURISTISCHE_SECTION_KW = [
  'geschäftsführer', 'geschaeftsfuehrer', 'handelsregister',
  'gesellschafter', 'überschuldung', 'ueberschuldung',
];

function removeConditionalSections(xml: string, result: ExtractionResult): string {
  const isEntity = isJuristischeOderGesellschaft(result);

  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let fullText = '';
    let m;
    while ((m = tRegex.exec(paragraph)) !== null) fullText += m[1];
    const text = fullText.trim().toLowerCase();
    if (!text) return paragraph;

    // Only remove paragraphs starting with conditional markers
    if (!/^\[(?:wenn|ggf|nur|falls|sofern|bei)\b/.test(text)) return paragraph;

    if (isEntity && NATUERLICHE_PERSON_SECTION_KW.some(kw => text.includes(kw))) return '';
    if (!isEntity && JURISTISCHE_SECTION_KW.some(kw => text.includes(kw))) return '';

    return paragraph;
  });
}

// --- XML field replacement (handles Word run-splitting) ---

function replaceFieldsInXml(xml: string, replacements: Record<string, string>): string {
  const sortedKeys = Object.keys(replacements).sort((a, b) => b.length - a.length);

  return processDocxParagraphs(
    xml,
    (text) => text.includes('KI_'),
    (text) => {
      let replaced = text;
      for (const key of sortedKeys) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped + '(?:_\\d+)?', 'g');
        replaced = replaced.replace(regex, replacements[key] ?? '');
      }
      replaced = replaced.replace(/KI_[\w\u00C0-\u024F]+/g, '');
      return replaced;
    }
  );
}

// --- Shared: load and prepare template ZIP with KI_* replaced ---

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
    let xmlContent = file.asText();
    // Phase 1: Replace KI_* placeholders (Tier 1 — direct extraction data)
    xmlContent = replaceFieldsInXml(xmlContent, replacements);
    // Phase 2: Inject dynamic tables (Tier 2 — deterministic from arrays)
    xmlContent = injectDynamicTables(xmlContent, result);
    // Phase 3: Remove conditional sections irrelevant for entity type
    xmlContent = removeConditionalSections(xmlContent, result);
    // Phase 4: Apply editorial rules from Word comments
    xmlContent = applyCommentRules(xmlContent, result);
    zip.file(partName, xmlContent);
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
