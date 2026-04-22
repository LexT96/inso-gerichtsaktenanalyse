import PizZip from 'pizzip';
import fs from 'fs';
import path from 'path';
import type { ExtractionResult } from '../types/extraction';
import { extractSlots, fillSlots, applySlots, type GutachtenSlot, type SlotInfo } from './gutachtenSlotFiller';

// Find gutachtenvorlagen/ — could be at cwd (Docker) or one level up (dev from backend/)
function findTemplatesDir(): string {
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..')]) {
    const candidate = path.join(base, 'gutachtenvorlagen');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), 'gutachtenvorlagen'); // fallback
}
const TEMPLATES_DIR = findTemplatesDir();
const MAPPING_PATH = path.join(TEMPLATES_DIR, 'gutachten-mapping.json');
const KANZLEI_PATH = path.join(TEMPLATES_DIR, 'kanzlei.json');

// Lazy-loaded court address lookup from kanzlei.json
let _kanzleiData: Record<string, unknown> | null = null;
function getKanzleiData(): Record<string, unknown> {
  if (!_kanzleiData) {
    _kanzleiData = JSON.parse(fs.readFileSync(KANZLEI_PATH, 'utf-8')) as Record<string, unknown>;
  }
  return _kanzleiData;
}

/** Expose path and cache reset for the kanzlei admin API */
export { KANZLEI_PATH };
export function invalidateKanzleiCache(): void { _kanzleiData = null; }

function lookupGerichtAddress(gerichtName: string): { adresse: string; plz_ort: string } | null {
  const data = getKanzleiData();
  const gerichte = data.insolvenzgerichte as Record<string, { name: string; adresse: string; plz_ort: string }> | undefined;
  if (!gerichte) return null;
  // Match by city name extracted from gericht (e.g., "Amtsgericht Wittlich" → "Wittlich")
  const lower = gerichtName.toLowerCase();
  for (const [city, info] of Object.entries(gerichte)) {
    if (lower.includes(city.toLowerCase())) return info;
  }
  return null;
}

// --- Types ---

export interface GutachtenUserInputs {
  verwalter_diktatzeichen: string;
  verwalter_geschlecht: 'maennlich' | 'weiblich';
  anderkonto_iban?: string;
  anderkonto_bank?: string;
  geschaeftsfuehrer?: string;
  last_gavv?: string;
  // Verwalter profile overrides (from persisted profiles)
  verwalter_name?: string;
  verwalter_titel?: string;
  verwalter_adresse?: string;
  verwalter_kanzlei?: string;
  verwalter_telefon?: string;
  verwalter_email?: string;
  verwalter_standort?: string;
  sachbearbeiter_name?: string;
  sachbearbeiter_email?: string;
  sachbearbeiter_durchwahl?: string;
  verwalter_standort_telefon?: string;
  /** Manual overrides per KI_* placeholder — fill in fields the extraction couldn't resolve. */
  field_overrides?: Record<string, string>;
}

export interface MissingField {
  feld: string;
  label: string;
  source: 'path' | 'computed' | 'input';
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
  // First unescape any pre-escaped entities to avoid double-escaping
  // (AI outputs &apos; literally, which would become &amp;apos;)
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

/** Search ermittlungsergebnisse and zusammenfassung for a keyword pattern (fallback for fields not yet directly extracted) */
function searchErmittlungenAndZusammenfassung(result: ExtractionResult, kw: RegExp): string {
  // Search ermittlungsergebnisse fields
  const erm = result.ermittlungsergebnisse as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(erm || {})) {
    if (kw.test(k) && v && typeof v === 'object' && 'wert' in v) {
      const val = (v as { wert: unknown }).wert;
      if (val != null && val !== '') return String(val);
    }
  }
  // Search zusammenfassung
  for (const z of (result.zusammenfassung ?? [])) {
    if (z.wert && kw.test(z.wert)) {
      return z.wert.length > 80 ? z.wert.slice(0, 80) + '…' : z.wert;
    }
  }
  return '';
}

/** InsVV § 2 Abs. 1 Regelvergütung + GKG Gerichtskosten */
function berechneVerfahrenskosten(berechnungsgrundlage: number): {
  verguetung_vorlaeufig: number;
  verguetung_eroeffnet: number;
  gerichtskosten: number;
  gesamt: number;
} {
  const STUFEN = [
    { bis: 25_000, satz: 0.40 },
    { bis: 50_000, satz: 0.25 },
    { bis: 250_000, satz: 0.07 },
    { bis: 500_000, satz: 0.03 },
    { bis: 25_000_000, satz: 0.02 },
    { bis: 50_000_000, satz: 0.01 },
    { bis: Infinity, satz: 0.005 },
  ];
  let verguetung = 0;
  let rest = Math.max(0, berechnungsgrundlage);
  let prevBis = 0;
  for (const { bis, satz } of STUFEN) {
    const stufenBreite = bis === Infinity ? rest : bis - prevBis;
    const stufenBetrag = Math.min(rest, stufenBreite);
    if (stufenBetrag <= 0) break;
    verguetung += stufenBetrag * satz;
    rest -= stufenBetrag;
    prevBis = bis === Infinity ? prevBis : bis;
  }
  verguetung = Math.max(verguetung, 1000); // § 2 Abs. 2 InsVV Mindestvergütung

  // GKG KV Nr. 2310 (vereinfachte Stufentabelle, Stand 2025)
  const GKG: [number, number][] = [
    [500, 38], [1000, 58], [1500, 78], [2000, 98], [3000, 119],
    [4000, 140], [5000, 161], [6000, 182], [7000, 203], [8000, 224],
    [9000, 245], [10000, 266], [13000, 295], [16000, 324], [19000, 353],
    [22000, 382], [25000, 411], [30000, 449], [35000, 487], [40000, 525],
    [45000, 563], [50000, 601], [65000, 733], [80000, 865], [95000, 997],
    [110000, 1129], [125000, 1261], [140000, 1393], [155000, 1525],
    [170000, 1657], [185000, 1789], [200000, 1921], [230000, 2119],
    [260000, 2317], [290000, 2515], [320000, 2713], [350000, 2911],
    [380000, 3109], [410000, 3307], [440000, 3505], [470000, 3703],
    [500000, 3901],
  ];
  let gebuehr = 3901;
  for (const [grenze, wert] of GKG) {
    if (berechnungsgrundlage <= grenze) { gebuehr = wert; break; }
  }
  const gerichtskosten = Math.round(gebuehr * 1.5 * 100) / 100;

  const r = (n: number) => Math.round(n * 100) / 100;
  // Vorläufig: 25% der Regelvergütung (§ 11 Abs. 1 S. 2 InsVV)
  const vorl = r(verguetung * 0.25);
  const eroff = r(verguetung);
  return {
    verguetung_vorlaeufig: vorl,
    verguetung_eroeffnet: eroff,
    gerichtskosten,
    gesamt: r(vorl + eroff + gerichtskosten),
  };
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

    case 'schuldner_dem_der':
      if (juristischOderGesellschaft) return 'der';
      return weiblichSchuldner ? 'der' : 'dem';

    case 'schuldner_des_der':
      if (juristischOderGesellschaft) return 'der';
      return weiblichSchuldner ? 'der' : 'des';

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
      // Prefer direct field, fallback to betroffene_arbeitnehmer count
      const directCount = result.schuldner?.arbeitnehmer_anzahl?.wert;
      if (directCount != null && directCount > 0) return String(directCount);
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

    // --- Direct schuldner fields with ermittlungsergebnisse fallback ---
    case 'finanzamt': {
      const v = result.schuldner?.finanzamt?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /finanzamt/i);
    }
    case 'steuernummer': {
      const v = result.schuldner?.steuernummer?.wert;
      if (v) return v;
      // Don't fall back to zusammenfassung — "Steuer" matches too broadly
      return '';
    }
    case 'letzter_jahresabschluss': {
      const v = result.schuldner?.letzter_jahresabschluss?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /jahresabschluss|bilanz/i);
    }
    case 'steuerberater': {
      const v = result.schuldner?.steuerberater?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /steuerberater/i);
    }
    case 'gerichtsvollzieher': {
      const v = result.ermittlungsergebnisse?.gerichtsvollzieher?.name?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /gerichtsvollzieher/i);
    }
    case 'sv_traeger': {
      const v = result.schuldner?.sozialversicherungstraeger?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /sozialversicherung|krankenkasse/i);
    }
    case 'ausbildung':
      return searchErmittlungenAndZusammenfassung(result, /ausbildung|beruf/i);

    case 'groessenklasse': {
      const v = result.schuldner?.groessenklasse_hgb?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /gr.{0,3}.enklasse|267.*hgb/i);
    }
    case 'gruendung': {
      const v = result.schuldner?.gruendungsdatum?.wert;
      if (v) return v;
      return searchErmittlungenAndZusammenfassung(result, /gr.{0,3}ndung|gegr.{0,3}ndet/i);
    }
    case 'gesellschafter': {
      // Prefer structured gesellschafter array
      const gs = result.schuldner?.gesellschafter;
      if (gs?.length) {
        return gs.map((g, i) =>
          `${i + 1}. ${g.name}${g.sitz ? ', ' + g.sitz : ''}${g.beteiligung ? ' — ' + g.beteiligung : ''}`
        ).join('\n');
      }
      return searchErmittlungenAndZusammenfassung(result, /gesellschafter|anteilseigner/i);
    }

    case 'bankverbindungen': {
      // Prefer schuldner.bankverbindungen, fallback to antragsteller
      const bv = result.schuldner?.bankverbindungen?.wert;
      if (bv) return bv;
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

    // --- Verfahrenskostenberechnung (InsVV) ---
    case 'verfahrenskosten_berechnung': {
      // Berechnungsgrundlage = freie Masse (§ 1 InsVV: Insolvenzmasse bei Schlussverteilung)
      const positionen = result.aktiva?.positionen ?? [];
      const berechnungsgrundlage = positionen.reduce((s, p) => {
        if (p.freie_masse?.wert != null) return s + safeNum(p.freie_masse.wert);
        const w = safeNum(p.geschaetzter_wert?.wert);
        const ab = safeNum(p.absonderung?.wert);
        const au = safeNum(p.aussonderung?.wert);
        return s + Math.max(0, w - ab - au);
      }, 0) || safeNum(result.aktiva?.summe_aktiva?.wert); // fallback to summe if no positionen
      if (berechnungsgrundlage <= 0) return '';
      const vk = berechneVerfahrenskosten(berechnungsgrundlage);
      return [
        `Vergütung vorläufiges Insolvenzverfahren: ${formatEUR(vk.verguetung_vorlaeufig)}`,
        `Vergütung eröffnetes Verfahren: ${formatEUR(vk.verguetung_eroeffnet)}`,
        `Gerichtskosten: ${formatEUR(vk.gerichtskosten)}`,
        `Gesamt: ${formatEUR(vk.gesamt)}`,
      ].join('\n');
    }

    case 'verfahrenskosten_gesamt': {
      const pos = result.aktiva?.positionen ?? [];
      const bg = pos.reduce((sum, p) => {
        if (p.freie_masse?.wert != null) return sum + safeNum(p.freie_masse.wert);
        return sum + Math.max(0, safeNum(p.geschaetzter_wert?.wert) - safeNum(p.absonderung?.wert) - safeNum(p.aussonderung?.wert));
      }, 0) || safeNum(result.aktiva?.summe_aktiva?.wert);
      if (bg <= 0) return '';
      return formatEUR(berechneVerfahrenskosten(bg).gesamt);
    }

    case 'freie_masse_gesamt': {
      const positionen = result.aktiva?.positionen ?? [];
      const total = positionen.reduce((s, p) => {
        if (p.freie_masse?.wert != null) return s + safeNum(p.freie_masse.wert);
        const w = safeNum(p.geschaetzter_wert?.wert);
        const ab = safeNum(p.absonderung?.wert);
        const au = safeNum(p.aussonderung?.wert);
        return s + Math.max(0, w - ab - au);
      }, 0);
      return total > 0 ? formatEUR(total) : '';
    }

    // --- Briefkopf ---
    case 'mein_zeichen': {
      const gericht = getByPath(result, 'verfahrensdaten.gericht.wert');
      const az = getByPath(result, 'verfahrensdaten.aktenzeichen.wert');
      if (gericht && az) return `${gericht}, Az. ${az}`;
      if (az) return az;
      return '';
    }

    case 'ihr_zeichen':
      return getByPath(result, 'verfahrensdaten.aktenzeichen.wert');

    case 'briefkopf_datum': {
      const now = new Date();
      const day = String(now.getDate()).padStart(2, '0');
      const month = String(now.getMonth() + 1).padStart(2, '0');
      return `${day}.${month}.${now.getFullYear()}`;
    }

    case 'briefkopf_ort':
      return inputs.verwalter_standort || 'Trier';

    case 'gericht_adresse': {
      const gericht = getByPath(result, 'verfahrensdaten.gericht.wert');
      const court = lookupGerichtAddress(gericht);
      return court?.adresse || '';
    }

    case 'gericht_plz_ort': {
      const gericht2 = getByPath(result, 'verfahrensdaten.gericht.wert');
      const court2 = lookupGerichtAddress(gericht2);
      return court2?.plz_ort || '';
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
      let val = (userInputs[inputKey] as string) ?? '';
      // Split comma-separated titles into line breaks for DOCX rendering
      if (inputKey === 'verwalter_titel' && val.includes(',')) {
        val = val.split(',').map(s => s.trim()).join('\n');
      }
      replacements[feld] = val;
    }
  }

  // Override with Verwalter profile data when provided (takes precedence over extraction)
  if (userInputs.verwalter_name) {
    replacements['KI_Verwalter_Name'] = userInputs.verwalter_name;
    replacements['KI_Verwalter_Unterzeichner'] = userInputs.verwalter_name;
  }
  if (userInputs.verwalter_adresse) {
    replacements['KI_Verwalter_Adr'] = userInputs.verwalter_adresse;
  }
  if (userInputs.verwalter_kanzlei) {
    replacements['KI_Gutachter_Kanzlei'] = userInputs.verwalter_kanzlei;
  }
  if (userInputs.verwalter_telefon) {
    replacements['KI_Gutachter_Telefon'] = userInputs.verwalter_telefon;
  }
  if (userInputs.verwalter_email) {
    replacements['KI_Gutachter_Email'] = userInputs.verwalter_email;
  }

  // Manual field_overrides win over everything (user-filled in wizard step 4)
  if (userInputs.field_overrides) {
    for (const [feld, val] of Object.entries(userInputs.field_overrides)) {
      if (typeof val === 'string' && val.trim()) {
        replacements[feld] = val.trim();
      }
    }
  }

  return replacements;
}

// --- Human-readable label derivation for KI_* placeholders ---

/** Convert a KI_* placeholder name to a human-readable German label. */
export function feldToLabel(feld: string): string {
  let name = feld.replace(/^KI_/, '');
  name = name.replace(/_/g, ' ');
  name = name.replace(/\bAdr\b/g, 'Adresse');
  name = name.replace(/\bAZ\b/g, 'Aktenzeichen');
  name = name.replace(/\bHRB\b/g, 'Handelsregister-Nr.');
  name = name.replace(/\bSVTraeger\b/gi, 'SV-Träger');
  name = name.replace(/\bGAVV\b/g, 'GAVV');
  name = name.replace(/Beschaeftigung/gi, 'Beschäftigung');
  name = name.replace(/Geschaeftsfuehrer/gi, 'Geschäftsführer');
  name = name.replace(/Staatsangehoerigkeit/gi, 'Staatsangehörigkeit');
  name = name.replace(/Pfaend/gi, 'Pfänd');
  name = name.replace(/Betriebsstaette/gi, 'Betriebsstätte');
  name = name.replace(/Gro(?:ss|ß)/gi, '');
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

// --- Compute which KI_* fields are present in the template but couldn't be resolved ---

/**
 * Collects placeholders that appear in the generated template's XML but resolve to empty.
 * Skips pure grammatical helpers (der/die/dem/des etc.) which always have a default.
 */
export function computeMissingFields(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs,
  templateType: TemplateType
): MissingField[] {
  const mapping = loadMapping();
  const templateFilename = mapping.templates[templateType];
  if (!templateFilename) return [];
  const templatePath = path.resolve(TEMPLATES_DIR, templateFilename);
  if (!fs.existsSync(templatePath)) return [];

  const zip = new PizZip(fs.readFileSync(templatePath, 'binary'));
  const allText: string[] = [];
  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (file) allText.push(file.asText());
  }
  const combined = allText.join('\n');

  const replacements = buildReplacements(result, userInputs);

  // Grammatical helpers that always have a default value — hide from missing UI
  const GRAMMATICAL_SUFFIXES = [
    'der_die', 'dem_der', 'den_die', 'des_der', 'des_', 'zum_', 'zum_zur',
    'Artikel', 'Der_Die_Groß', 'Der_Die_Gross',
    'Schuldnerin', 'Schuldners_Schuldnerin', 'Unterzeichner_Genitiv',
  ];

  const seen = new Set<string>();
  const missing: MissingField[] = [];
  for (const [feld, def] of Object.entries(mapping.felder)) {
    if (seen.has(feld)) continue;
    if (!combined.includes(feld)) continue; // not used in this template
    const value = replacements[feld] ?? '';
    if (value.trim() !== '') continue;

    // Skip grammatical helpers that compute a default even without data
    const short = feld.replace(/^KI_/, '');
    const isHelper = GRAMMATICAL_SUFFIXES.some(suffix => short.endsWith(suffix));
    if (isHelper) continue;

    seen.add(feld);
    const source: 'path' | 'computed' | 'input' =
      def.path ? 'path' : def.computed ? 'computed' : 'input';
    missing.push({ feld, label: feldToLabel(feld), source });
  }

  return missing.sort((a, b) => a.label.localeCompare(b.label, 'de'));
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
          () => `<w:t xml:space="preserve">${escapeXml(unescapeXmlEntities(replaced))}</w:t>`
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
  const rPr: string[] = ['<w:rFonts w:ascii="Avenir LT Std 35 Light" w:hAnsi="Avenir LT Std 35 Light"/><w:sz w:val="18"/><w:szCs w:val="18"/>'];
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

  // Check if any position has the extended fields (absonderung/aussonderung)
  const hasExtended = positionen.some(p =>
    p.absonderung?.wert != null || p.aussonderung?.wert != null || p.freie_masse?.wert != null
  );

  if (hasExtended) {
    // ─── Real Gutachten format: 5-column table ───
    return buildAktivaTableExtended(positionen, result);
  }

  // ─── Legacy format: 3-column table ───
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

/** Build Aktiva table matching real TBS Gutachten: Bezeichnung | Wert | Absonderung | Aussonderung | Freie Masse */
function buildAktivaTableExtended(
  positionen: import('../types/extraction').Aktivum[],
  result: ExtractionResult
): string {
  const fmtEUR = (v: number | null | undefined) => v != null && v > 0 ? formatEUR(v) : '0,00';

  // Group: 1. Anlagevermögen, 2. Umlaufvermögen
  const anlage = ['immobilien', 'fahrzeuge', 'bewegliches_vermoegen', 'geschaeftsausstattung', 'wertpapiere_beteiligungen', 'lebensversicherungen'];
  const umlauf = ['forderungen_schuldner', 'bankguthaben', 'steuererstattungen', 'einkommen'];

  const anlagePos = positionen.filter(p => anlage.includes(p.kategorie));
  const umlaufPos = positionen.filter(p => umlauf.includes(p.kategorie));

  const headerRow = tblRow([
    tblCell('Bezeichnung', { bold: true, width: 1800, shading: 'C00000' }),
    tblCell('Wert (EUR)', { bold: true, rightAlign: true, width: 800, shading: 'C00000' }),
    tblCell('Absonderung', { bold: true, rightAlign: true, width: 800, shading: 'C00000' }),
    tblCell('Aussonderung', { bold: true, rightAlign: true, width: 800, shading: 'C00000' }),
    tblCell('Freie Masse', { bold: true, rightAlign: true, width: 800, shading: 'C00000' }),
  ], true);

  const rows: string[] = [headerRow];

  const addGroup = (label: string, items: typeof positionen) => {
    if (items.length === 0) return;
    let grpWert = 0, grpAbs = 0, grpAus = 0, grpFrei = 0;
    for (const p of items) {
      const w = safeNum(p.liquidationswert?.wert ?? p.geschaetzter_wert?.wert);
      const a = safeNum(p.absonderung?.wert);
      const au = safeNum(p.aussonderung?.wert);
      const f = p.freie_masse?.wert != null ? safeNum(p.freie_masse.wert) : Math.max(0, w - a - au);
      grpWert += w; grpAbs += a; grpAus += au; grpFrei += f;
      rows.push(tblRow([
        tblCell(String(p.beschreibung?.wert || KATEGORIE_LABELS[p.kategorie] || p.kategorie)),
        tblCell(fmtEUR(w), { rightAlign: true }),
        tblCell(fmtEUR(a), { rightAlign: true }),
        tblCell(fmtEUR(au), { rightAlign: true }),
        tblCell(fmtEUR(f), { rightAlign: true }),
      ]));
    }
    // Group subtotal
    rows.push(tblRow([
      tblCell(label, { bold: true, shading: 'F2F2F2' }),
      tblCell(fmtEUR(grpWert), { bold: true, rightAlign: true, shading: 'F2F2F2' }),
      tblCell(fmtEUR(grpAbs), { bold: true, rightAlign: true, shading: 'F2F2F2' }),
      tblCell(fmtEUR(grpAus), { bold: true, rightAlign: true, shading: 'F2F2F2' }),
      tblCell(fmtEUR(grpFrei), { bold: true, rightAlign: true, shading: 'F2F2F2' }),
    ]));
    return { wert: grpWert, abs: grpAbs, aus: grpAus, frei: grpFrei };
  };

  const a1 = addGroup('1. Anlagevermögen (Gesamt)', anlagePos) || { wert: 0, abs: 0, aus: 0, frei: 0 };
  const a2 = addGroup('2. Umlaufvermögen (Gesamt)', umlaufPos) || { wert: 0, abs: 0, aus: 0, frei: 0 };

  // Grand total
  rows.push(tblRow([
    tblCell('\u03A3', { bold: true, shading: 'E8E8E8' }),
    tblCell(fmtEUR(a1.wert + a2.wert), { bold: true, rightAlign: true, shading: 'E8E8E8' }),
    tblCell(fmtEUR(a1.abs + a2.abs), { bold: true, rightAlign: true, shading: 'E8E8E8' }),
    tblCell(fmtEUR(a1.aus + a2.aus), { bold: true, rightAlign: true, shading: 'E8E8E8' }),
    tblCell(fmtEUR(a1.frei + a2.frei), { bold: true, rightAlign: true, shading: 'E8E8E8' }),
  ]));

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

/** Passiva table matching real Gutachten: Gläubiger | Betrag in EUR */
function buildPassivaTable(result: ExtractionResult): string {
  const ef = result.forderungen?.einzelforderungen ?? [];
  if (ef.length === 0) return '';

  const rows: string[] = [];
  rows.push(tblRow([
    tblCell('Gläubiger', { bold: true, width: 3500, shading: 'C00000' }),
    tblCell('Betrag in EUR', { bold: true, rightAlign: true, width: 1200, shading: 'C00000' }),
  ], true));

  for (const f of ef) {
    const betrag = safeNum(f.betrag?.wert);
    rows.push(tblRow([
      tblCell(String(f.glaeubiger?.wert || '\u2014')),
      tblCell(betrag > 0 ? formatEUR(betrag, false) : '\u2014', { rightAlign: true }),
    ]));
  }

  const gesamt = result.forderungen?.gesamtforderungen?.wert;
  const total = gesamt != null ? formatEUR(gesamt, false) : formatEUR(
    ef.reduce((s, f) => s + safeNum(f.betrag?.wert), 0), false
  );
  rows.push(tblRow([
    tblCell('\u03A3', { bold: true, shading: 'E8E8E8' }),
    tblCell(total, { bold: true, rightAlign: true, shading: 'E8E8E8' }),
  ]));

  return wrapTable(rows);
}

const TABLE_PATTERNS: { pattern: RegExp; builder: (r: ExtractionResult) => string }[] = [
  { pattern: /\[(?:Tabelle[:\s]*)?Gl.{0,10}ubiger/i, builder: buildGlaeubigerTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Forderung/i, builder: buildGlaeubigerTable },
  { pattern: /\[(?:Tabelle[:\s]*)?Passiva/i, builder: buildPassivaTable },
  { pattern: /\[\[SLOT_\d+:\s*Tabelle\]\]/i, builder: buildPassivaTable }, // Generic [[SLOT: Tabelle]] → Passiva
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
  const raw = result.gutachterbestellung?.befugnisse;
  const befugnisse = Array.isArray(raw) ? raw : [];
  return befugnisse.some((b: unknown) => typeof b === 'string' &&
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
  // Primary: use explicit extraction field
  const ib = result.verfahrensdaten?.internationaler_bezug?.wert;
  if (ib === true) return true;
  if (ib === false) return false;
  // Fallback (field not extracted): check for non-German nationality or foreign addresses
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

// --- Template instruction cleanup (uses processDocxParagraphs for run-splitting safety) ---

function cleanupTemplateInstructions(xml: string, result: ExtractionResult): string {
  const isVorlIV = isVorlaeufigverwalter(result);

  // Patterns to remove entirely (editorial instructions that leaked into output)
  const REMOVE_PATTERNS = [
    /^\[kollektivarbeitsrechtliche und betriebsverfassungsrechtliche Verhältnisse.*\]$/i,
    /^\[nicht nur Wiedergabe des oftmals wenig sagenden.*\]$/i,
    /^\[Das Unternehmen hat einen handelsrechtlich nicht bilanzierbaren.*\]$/i,
    /^optional:\s*bei zusätzlicher Belastung.*$/i,
    /^-\s*Datensicherung in komplexen EDV-Systemen/i,
    /^-\s*Datenaufbereitung aus branchenspezifischer Software/i,
    /^-\s*Datenwiederherstellung \(gelöschte Daten/i,
    /^\[falls schon erkennbar Nennung von Beweisanzeichen.*\]$/i,
    /^\[wenn überschaubare arbeitsrechtliche Verhältnisse.*\]$/i,
  ];

  // Text replacements (old → new)
  const TEXT_FIXES: [RegExp, string][] = [];

  // Fix signature line if not vorl. IV
  if (!isVorlIV) {
    TEXT_FIXES.push(
      [/als Sachverständige[r]?\s+und\s+vorläufige[r]?\s+Insolvenzverwalter(in)?/gi, 'als Sachverständiger'],
      [/Gutachten und Bericht/g, 'Gutachten'],
      [/und erstattet hiermit Bericht über den Verlauf des Antragsverfahrens:/g, ':'],
    );
  }

  // Fix "Lohnrückstände sind 1 aufgelaufen" (Arbeitnehmer count leaked)
  // Keep this generic — if a number directly follows "Lohnrückstände sind" and is 1-digit, it's likely wrong
  TEXT_FIXES.push(
    [/Er\/Sie führte auch die Lohnbuchhaltung der Schuldnerin\./g, ''],
  );

  // Fix "der Schuldnerin" → "des Schuldners" for natürliche Person male
  // (template defaults to "Schuldnerin" but Schuldner may be male)

  return processDocxParagraphs(
    xml,
    (text) => {
      const lower = text.toLowerCase();
      // Check if paragraph matches any remove pattern
      for (const p of REMOVE_PATTERNS) {
        if (p.test(text.trim())) return true;
      }
      // Check text fixes
      for (const [pattern] of TEXT_FIXES) {
        if (pattern.test(text)) return true;
      }
      return false;
    },
    (text) => {
      // Check remove patterns first
      for (const p of REMOVE_PATTERNS) {
        if (p.test(text.trim())) return '';
      }
      // Apply text fixes
      let result = text;
      for (const [pattern, replacement] of TEXT_FIXES) {
        result = result.replace(pattern, replacement);
      }
      return result;
    }
  );
}

// --- XML field replacement (handles Word run-splitting) ---

// --- Track Changes (Änderungen nachverfolgen) ---
// Wraps AI-filled text in <w:ins>/<w:del> so Word shows them as tracked changes.
// The lawyer can Accept All or review each change individually.

let _revisionId = 100; // Start high to avoid conflicts with existing revision IDs
function nextRevisionId(): number { return _revisionId++; }

const TRACK_CHANGES_AUTHOR = 'KI-Assistent';
const TRACK_CHANGES_DATE = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/** Unescape XML entities that AI may have pre-escaped */
function unescapeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"');
}

/** Build a <w:ins> tracked insertion run */
function trackInsert(text: string, rprXml?: string): string {
  const id = nextRevisionId();
  const rpr = rprXml ? `<w:rPr>${rprXml}</w:rPr>` : '';
  // 1. Unescape any pre-escaped XML entities (AI outputs &apos; literally)
  // 2. Strip [...] brackets (AI artifacts) — preserve [TODO:] and [[SLOT_]]
  // 3. escapeXml re-escapes properly for Word XML
  let cleaned = unescapeXmlEntities(text);
  cleaned = cleaned.replace(/\[(?!TODO:|SLOT_|\[)([^\]]*)\]/g, '$1');
  // Support line breaks (\n) in replacement values → <w:br/> in Word XML
  const lines = cleaned.split('\n');
  const runs = lines.map((line, i) => {
    const br = i < lines.length - 1 ? '<w:br/>' : '';
    return `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(line)}</w:t>${br}</w:r>`;
  }).join('');
  return `<w:ins w:id="${id}" w:author="${escapeXml(TRACK_CHANGES_AUTHOR)}" w:date="${TRACK_CHANGES_DATE}">${runs}</w:ins>`;
}

/** Build a <w:del> tracked deletion run */
function trackDelete(text: string, rprXml?: string): string {
  const id = nextRevisionId();
  const rpr = rprXml ? `<w:rPr>${rprXml}</w:rPr>` : '';
  return `<w:del w:id="${id}" w:author="${escapeXml(TRACK_CHANGES_AUTHOR)}" w:date="${TRACK_CHANGES_DATE}"><w:r>${rpr}<w:delText xml:space="preserve">${escapeXml(text)}</w:delText></w:r></w:del>`;
}

/**
 * Replace KI_* fields. Two strategies:
 * - Paragraphs with tabs or complex structure -> in-place (preserves formatting)
 * - Simple paragraphs -> tracked changes (visible markers for review)
 */
function replaceFieldsInXml(xml: string, replacements: Record<string, string>): string {
  const sortedKeys = Object.keys(replacements).sort((a, b) => b.length - a.length);

  function doReplace(fullText: string): string {
    let replaced = fullText;
    for (const key of sortedKeys) {
      const val = replacements[key];
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped + '(?:_\\d+)?', 'g');
      const finalVal = (val !== undefined && val.trim() !== '') ? val : `[TODO: ${feldToLabel(key)}]`;
      replaced = replaced.replace(regex, finalVal);
    }
    replaced = replaced.replace(/KI_[\w\u00C0-\u024F]+/g, (match) => `[TODO: ${feldToLabel(match)}]`);
    return replaced;
  }

  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    const texts: string[] = [];
    let match;
    while ((match = tRegex.exec(paragraph)) !== null) {
      texts.push(match[1]);
    }
    if (texts.length === 0) return paragraph;

    const fullText = texts.join('');
    if (!fullText.includes('KI_')) return paragraph;

    const replaced = doReplace(fullText);
    if (replaced === fullText) return paragraph;

    // Paragraphs with tabs -> in-place replacement (preserve tabs + formatting)
    if (paragraph.includes('<w:tab/>') || paragraph.includes('<w:tab ')) {
      let result = paragraph;
      let firstDone = false;
      const tRegex2 = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
      let m;
      while ((m = tRegex2.exec(paragraph)) !== null) {
        if (!firstDone) {
          result = result.replace(
            m[0],
            () => `<w:t xml:space="preserve">${escapeXml(unescapeXmlEntities(replaced))}</w:t>`
          );
          firstDone = true;
        } else {
          result = result.replace(m[0], () => '<w:t></w:t>');
        }
      }
      return result;
    }

    // Simple paragraphs -> tracked changes for review visibility
    const rprMatch = paragraph.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
    const rprXml = rprMatch ? rprMatch[1] : '';

    let result = paragraph;
    result = result.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, '');
    result = result.replace(
      /<\/w:p>/,
      () => trackDelete(fullText, rprXml) + trackInsert(replaced, rprXml) + '</w:p>'
    );
    return result;
  });
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
    // Phase 5: Clean up template instructions and boilerplate
    xmlContent = cleanupTemplateInstructions(xmlContent, result);
    zip.file(partName, xmlContent);
  }

  return { zip, templateType, replacements };
}

// --- Prepare: extract slots and fill via Claude ---

export async function prepareGutachten(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs
): Promise<{
  templateType: TemplateType;
  slots: GutachtenSlot[];
  feldValues: Record<string, string>;
  missingFields: MissingField[];
}> {
  const { zip, templateType, replacements } = loadAndPrepareTemplate(result, userInputs);

  let allSlots: SlotInfo[] = [];
  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const { slots } = extractSlots(file.asText());
    allSlots = allSlots.concat(slots);
  }

  const filledSlots = await fillSlots(allSlots, result);
  const missingFields = computeMissingFields(result, userInputs, templateType);

  return { templateType, slots: filledSlots, feldValues: replacements, missingFields };
}

// --- Generate: apply final slot values and return DOCX buffer ---

export function generateGutachtenFinal(
  result: ExtractionResult,
  userInputs: GutachtenUserInputs,
  finalSlots: { id: string; value: string }[]
): Buffer {
  const { zip } = loadAndPrepareTemplate(result, userInputs);
  const slotMap = new Map(finalSlots.map(s => [s.id, s.value]));

  for (const partName of XML_PARTS) {
    const file = zip.file(partName);
    if (!file) continue;
    const { xml: slottedXml, slots } = extractSlots(file.asText());

    // Apply slots with Track Changes: wrap each replacement in <w:ins>/<w:del>
    let finalXml = slottedXml;
    for (const slot of slots) {
      const value = slotMap.get(slot.id);
      if (!value) continue;

      const marker = `[[${slot.id}]]`;
      // Find the <w:t> containing this slot marker and wrap in tracked change
      const markerEscaped = escapeXml(marker);
      finalXml = finalXml.replace(
        new RegExp(`(<w:t[^>]*>)([^<]*${markerEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]*)(</w:t>)`),
        (_match, openTag, textContent, closeTag) => {
          // Extract rPr from the parent <w:r> if available
          const rprMatch = finalXml.slice(Math.max(0, finalXml.indexOf(_match) - 500), finalXml.indexOf(_match)).match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
          const rprXml = rprMatch ? rprMatch[1] : '';

          const originalText = textContent.replace(markerEscaped, slot.original || marker);
          const replacedText = textContent.replace(markerEscaped, escapeXml(value));

          return trackDelete(originalText, rprXml) + trackInsert(replacedText, rprXml);
        }
      );
    }

    // Also apply remaining slots normally (those without tracked changes)
    finalXml = applySlots(finalXml, finalSlots);

    // Convert any remaining [[SLOT_NNN...]] markers to [TODO: description]
    finalXml = processDocxParagraphs(
      finalXml,
      (text) => text.includes('[[SLOT_'),
      (text) => text.replace(/\[\[SLOT_\d{3}(?::([^\]]+))?\]\]/g, (_match, desc) => {
        return desc ? `[TODO: ${desc.trim()}]` : '[TODO: Angabe erforderlich]';
      })
    );

    zip.file(partName, finalXml);
  }

  return zip.generate({ type: 'nodebuffer' }) as Buffer;
}
