import { useMemo } from 'react';
import { Section } from '../Section';
import { usePdf } from '../../../contexts/PdfContext';
import type { ExtractionResult } from '../../../types/extraction';

interface QuellenTabProps {
  result: ExtractionResult;
}

interface FieldRef {
  label: string;
  wert: string;
  quelle: string;
  page: number;
  verifiziert?: boolean;
}

interface DocumentGroup {
  docType: string;
  minPage: number;
  maxPage: number;
  fields: FieldRef[];
}

// Human-readable labels for field paths
const FIELD_LABELS: Record<string, string> = {
  'verfahrensdaten.aktenzeichen': 'Aktenzeichen',
  'verfahrensdaten.gericht': 'Gericht',
  'verfahrensdaten.richter': 'Richter',
  'verfahrensdaten.antragsdatum': 'Antragsdatum',
  'verfahrensdaten.beschlussdatum': 'Beschlussdatum',
  'verfahrensdaten.antragsart': 'Antragsart',
  'verfahrensdaten.eroeffnungsgrund': 'Eröffnungsgrund',
  'verfahrensdaten.zustellungsdatum_schuldner': 'Zustellung Schuldner',
  'schuldner.name': 'Schuldner Name',
  'schuldner.vorname': 'Schuldner Vorname',
  'schuldner.geburtsdatum': 'Geburtsdatum',
  'schuldner.geburtsort': 'Geburtsort',
  'schuldner.geburtsland': 'Geburtsland',
  'schuldner.staatsangehoerigkeit': 'Staatsangehörigkeit',
  'schuldner.familienstand': 'Familienstand',
  'schuldner.geschlecht': 'Geschlecht',
  'schuldner.aktuelle_adresse': 'Aktuelle Adresse',
  'schuldner.firma': 'Firma',
  'schuldner.rechtsform': 'Rechtsform',
  'schuldner.betriebsstaette_adresse': 'Betriebsstätte',
  'schuldner.handelsregisternummer': 'Handelsregister-Nr.',
  'antragsteller.name': 'Antragsteller Name',
  'antragsteller.adresse': 'Antragsteller Adresse',
  'antragsteller.ansprechpartner': 'Ansprechpartner',
  'antragsteller.telefon': 'Telefon',
  'antragsteller.fax': 'Fax',
  'antragsteller.email': 'E-Mail',
  'antragsteller.betriebsnummer': 'Betriebsnummer',
  'antragsteller.bankverbindung_iban': 'IBAN',
  'antragsteller.bankverbindung_bic': 'BIC',
  'forderungen.hauptforderung_beitraege': 'Hauptforderung',
  'forderungen.saeumniszuschlaege': 'Säumniszuschläge',
  'forderungen.mahngebuehren': 'Mahngebühren',
  'forderungen.vollstreckungskosten': 'Vollstreckungskosten',
  'forderungen.antragskosten': 'Antragskosten',
  'forderungen.gesamtforderung': 'Gesamtforderung',
  'forderungen.zeitraum_von': 'Zeitraum von',
  'forderungen.zeitraum_bis': 'Zeitraum bis',
  'forderungen.laufende_monatliche_beitraege': 'Lfd. Beiträge',
  'gutachterbestellung.gutachter_name': 'Gutachter Name',
  'gutachterbestellung.gutachter_kanzlei': 'Gutachter Kanzlei',
  'gutachterbestellung.gutachter_adresse': 'Gutachter Adresse',
  'gutachterbestellung.gutachter_telefon': 'Gutachter Telefon',
  'gutachterbestellung.gutachter_email': 'Gutachter E-Mail',
  'gutachterbestellung.abgabefrist': 'Abgabefrist',
  'ermittlungsergebnisse.grundbuch.ergebnis': 'Grundbuch Ergebnis',
  'ermittlungsergebnisse.grundbuch.grundbesitz_vorhanden': 'Grundbesitz vorhanden',
  'ermittlungsergebnisse.grundbuch.datum': 'Grundbuch Datum',
  'ermittlungsergebnisse.gerichtsvollzieher.name': 'GV Name',
  'ermittlungsergebnisse.gerichtsvollzieher.betriebsstaette_bekannt': 'Betriebsstätte bekannt',
  'ermittlungsergebnisse.gerichtsvollzieher.vollstreckungen': 'Vollstreckungen',
  'ermittlungsergebnisse.gerichtsvollzieher.masse_deckend': 'Masse deckend',
  'ermittlungsergebnisse.gerichtsvollzieher.vermoegensauskunft_abgegeben': 'VA abgegeben',
  'ermittlungsergebnisse.gerichtsvollzieher.haftbefehle': 'Haftbefehle',
  'ermittlungsergebnisse.gerichtsvollzieher.datum': 'GV Datum',
  'ermittlungsergebnisse.vollstreckungsportal.schuldnerverzeichnis_eintrag': 'Schuldnerverzeichnis',
  'ermittlungsergebnisse.vollstreckungsportal.vermoegensverzeichnis_eintrag': 'Vermögensverzeichnis',
  'ermittlungsergebnisse.meldeauskunft.meldestatus': 'Meldestatus',
  'ermittlungsergebnisse.meldeauskunft.datum': 'Meldeauskunft Datum',
};

function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract document type from quelle string.
 * "Seite 3, Beschluss vom 18.12.2025" → "Beschluss"
 * "Seite 7, Mitteilung des Gerichtsvollziehers" → "Mitteilung des Gerichtsvollziehers"
 */
function extractDocType(quelle: string): string {
  // Remove the "Seite X, " prefix
  const afterPage = quelle.replace(/^(?:Seiten?\s+\d+(?:\s*[-–]\s*\d+)?|S\.?\s*\d+)[,;:\s]+/i, '').trim();
  if (!afterPage) return 'Sonstige';

  // Remove dates, "vom/am/des" before dates, trailing punctuation
  let normalized = afterPage
    .replace(/\s+(vom|am|des|der|v\.)\s+\d{1,2}\.\d{1,2}\.\d{2,4}/gi, '')
    .replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, '')
    .replace(/[,;:\s]+$/, '')
    .trim();

  if (!normalized) return 'Sonstige';

  // Capitalize first letter
  normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);

  return normalized;
}

function formatValue(wert: unknown): string {
  if (wert === null || wert === undefined || wert === '') return '';
  if (typeof wert === 'number') {
    return wert.toLocaleString('de-DE', { minimumFractionDigits: wert % 1 !== 0 ? 2 : 0 });
  }
  if (typeof wert === 'boolean') return wert ? 'Ja' : 'Nein';
  return String(wert);
}

function collectAllFields(result: ExtractionResult): FieldRef[] {
  const refs: FieldRef[] = [];

  const walk = (obj: unknown, prefix: string) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return;

    if ('wert' in (obj as Record<string, unknown>) && 'quelle' in (obj as Record<string, unknown>)) {
      const field = obj as { wert: unknown; quelle: string; verifiziert?: boolean };
      const wert = formatValue(field.wert);
      if (!wert) return;
      const page = field.quelle ? parsePageNumber(field.quelle) : null;
      if (page === null) return;
      refs.push({
        label: FIELD_LABELS[prefix] || prefix.split('.').pop() || prefix,
        wert,
        quelle: field.quelle,
        page,
        verifiziert: field.verifiziert,
      });
      return;
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        walk(obj[i], `${prefix}[${i}]`);
      }
      return;
    }

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      walk(value, prefix ? `${prefix}.${key}` : key);
    }
  };

  walk(result.verfahrensdaten, 'verfahrensdaten');
  walk(result.schuldner, 'schuldner');
  walk(result.antragsteller, 'antragsteller');
  walk(result.forderungen, 'forderungen');
  walk(result.gutachterbestellung, 'gutachterbestellung');
  walk(result.ermittlungsergebnisse, 'ermittlungsergebnisse');

  if (result.zusammenfassung) {
    for (const s of result.zusammenfassung) {
      if (s?.wert && s?.quelle) {
        const page = parsePageNumber(s.quelle);
        if (page !== null) {
          refs.push({ label: 'Zusammenfassung', wert: String(s.wert), quelle: s.quelle, page });
        }
      }
    }
  }

  if (result.risiken_hinweise) {
    for (const r of result.risiken_hinweise) {
      if (r?.wert && r?.quelle) {
        const page = parsePageNumber(r.quelle);
        if (page !== null) {
          refs.push({ label: 'Risiko/Hinweis', wert: String(r.wert), quelle: r.quelle, page });
        }
      }
    }
  }

  return refs;
}

function groupByDocument(fields: FieldRef[]): DocumentGroup[] {
  const groups = new Map<string, FieldRef[]>();

  for (const f of fields) {
    const docType = extractDocType(f.quelle);
    const list = groups.get(docType) || [];
    list.push(f);
    groups.set(docType, list);
  }

  const result: DocumentGroup[] = [];
  for (const [docType, groupFields] of groups) {
    const pages = groupFields.map(f => f.page);
    result.push({
      docType,
      minPage: Math.min(...pages),
      maxPage: Math.max(...pages),
      fields: groupFields.sort((a, b) => a.page - b.page),
    });
  }

  // Sort groups by first page appearance
  return result.sort((a, b) => a.minPage - b.minPage);
}

function formatPageRange(min: number, max: number): string {
  return min === max ? `S. ${min}` : `S. ${min} \u2013 ${max}`;
}

function FieldRow({ field }: { field: FieldRef }) {
  const { goToPageAndHighlight, totalPages } = usePdf();

  const handleClick = () => {
    if (totalPages > 0) {
      goToPageAndHighlight(field.page, field.wert);
    }
  };

  return (
    <tr
      className="border-b border-border hover:bg-surface-high cursor-pointer transition-colors"
      onClick={handleClick}
    >
      <td className="py-1.5 px-2 text-[10px] font-mono text-ie-blue w-[40px] align-top whitespace-nowrap">
        S.{field.page}
      </td>
      <td className="py-1.5 px-2 text-[11px] text-text-dim w-[150px] align-top font-sans">
        {field.label}
      </td>
      <td className="py-1.5 px-2 text-xs font-mono text-text max-w-[280px] truncate align-top">
        {field.wert}
      </td>
      <td className="py-1.5 px-2 text-center align-top w-[24px]">
        {field.verifiziert === true && <span className="text-ie-green text-[10px]" title="Verifiziert">{'\u2713'}</span>}
        {field.verifiziert === false && <span className="text-ie-amber text-[10px]" title="Nicht verifiziert">?</span>}
      </td>
    </tr>
  );
}

export function QuellenTab({ result }: QuellenTabProps) {
  const allFields = useMemo(() => collectAllFields(result), [result]);
  const docGroups = useMemo(() => groupByDocument(allFields), [allFields]);

  const verifiedCount = allFields.filter(f => f.verifiziert === true).length;
  const unverifiedCount = allFields.filter(f => f.verifiziert === false).length;

  return (
    <>
      <div className="bg-surface border border-border rounded-sm mb-2.5 p-3 px-4 flex items-center gap-4 text-[11px] font-sans">
        <span className="text-text-dim">
          <span className="font-bold text-text">{allFields.length}</span> Felder aus <span className="font-bold text-text">{docGroups.length}</span> Dokumenten
        </span>
        {verifiedCount > 0 && (
          <span className="text-ie-green">{'\u2713'} {verifiedCount} verifiziert</span>
        )}
        {unverifiedCount > 0 && (
          <span className="text-ie-amber">? {unverifiedCount} ungepr\u00fcft</span>
        )}
      </div>

      {docGroups.map((group) => (
        <Section
          key={`${group.docType}-${group.minPage}`}
          title={`${group.docType} (${formatPageRange(group.minPage, group.maxPage)})`}
          icon={'\u25a1'}
          count={group.fields.length}
        >
          <table className="w-full">
            <tbody>
              {group.fields.map((f, i) => (
                <FieldRow key={i} field={f} />
              ))}
            </tbody>
          </table>
        </Section>
      ))}
    </>
  );
}
