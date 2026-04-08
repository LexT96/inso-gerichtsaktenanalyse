import { useMemo } from 'react';
import { Section } from '../Section';
import { EmptyState } from '../EmptyState';
import { usePdf } from '../../../contexts/PdfContext';
import type { Forderungen, ForderungsArt, ForderungsRang, Einzelforderung } from '../../../types/extraction';
import { DataField } from '../DataField';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

const ART_LABELS: Record<ForderungsArt, string> = {
  sozialversicherung: 'Sozialversicherung',
  steuer: 'Steuerforderungen',
  bank: 'Bankforderungen',
  lieferant: 'Lieferantenforderungen',
  arbeitnehmer: 'Arbeitnehmerforderungen',
  miete: 'Mietforderungen',
  sonstige: 'Sonstige Forderungen',
};

const ART_ORDER: ForderungsArt[] = [
  'sozialversicherung', 'steuer', 'bank', 'lieferant', 'arbeitnehmer', 'miete', 'sonstige',
];

const RANG_SHORT: Record<ForderungsRang, { label: string; className: string }> = {
  '§38 Insolvenzforderung': { label: '§38', className: 'text-text-muted' },
  '§39 Nachrangig': { label: '§39', className: 'text-amber-400' },
  'Masseforderung §55': { label: '§55', className: 'text-red-400' },
};

const SICHERHEIT_LABELS: Record<string, string> = {
  grundschuld: 'Grundschuld',
  sicherungsuebereignung: 'SÜ',
  eigentumsvorbehalt: 'EV',
  pfandrecht: 'Pfandrecht',
  buergschaft: 'Bürgschaft',
  sonstige: 'Sicherheit',
};

function getNum(field: { wert: number | null } | null | undefined): number | null {
  if (!field) return null;
  const v = field.wert;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** Safely extract a numeric wert, coercing strings like "1299370.35" to numbers */
function safeWert(field: { wert: number | null } | null | undefined): number {
  if (!field) return 0;
  const v = field.wert;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  // Handle German number format: "100.608,33" → 100608.33
  const s = String(v).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function hasLegacyData(f: Forderungen): boolean {
  return !!(f?.hauptforderung_beitraege?.wert !== null && f?.hauptforderung_beitraege?.wert !== undefined);
}

// ─── Clickable source badge ───

function QuelleButton({ quelle, searchText }: { quelle: string; searchText?: string }) {
  const { goToPageAndHighlight, totalPages } = usePdf();
  const pageNum = parsePageNumber(quelle);
  if (!pageNum) return null;

  return (
    <button
      onClick={() => totalPages > 0 && goToPageAndHighlight(pageNum, searchText, quelle)}
      className="text-[8px] font-mono text-ie-blue border border-ie-blue/30 rounded px-1 py-px hover:border-ie-blue transition-colors"
      title={quelle}
    >
      S.{pageNum}
    </button>
  );
}

// ─── Main component ───

interface ForderungenTabProps {
  forderungen: Forderungen;
}

export function ForderungenTab({ forderungen: f }: ForderungenTabProps) {
  const einzelforderungen = f?.einzelforderungen ?? [];

  const grouped = useMemo(() => {
    const map = new Map<ForderungsArt, Einzelforderung[]>();
    for (const ef of einzelforderungen) {
      const list = map.get(ef.art) || [];
      list.push(ef);
      map.set(ef.art, list);
    }
    return ART_ORDER.filter(art => map.has(art)).map(art => ({ art, items: map.get(art)! }));
  }, [einzelforderungen]);

  const gesamtVal = getNum(f?.gesamtforderungen);
  const gesichertVal = getNum(f?.gesicherte_forderungen);
  const ungesichertVal = getNum(f?.ungesicherte_forderungen);
  const computedTotal = useMemo(
    () => einzelforderungen.reduce((sum, ef) => sum + safeWert(ef.betrag), 0),
    [einzelforderungen]
  );

  const hasEinzelforderungen = einzelforderungen.length > 0;
  const hasLegacy = hasLegacyData(f);
  const hasArbeitnehmer = (f?.betroffene_arbeitnehmer?.length ?? 0) > 0;

  // Empty state
  if (!hasEinzelforderungen && !hasLegacy && !hasArbeitnehmer && gesamtVal === null) {
    return (
      <EmptyState
        icon="€"
        title="Keine Forderungen in der Akte identifiziert."
        description="Die KI hat keine Gläubigeraufstellung in den analysierten Dokumenten gefunden."
      />
    );
  }

  // Legacy fallback
  if (!hasEinzelforderungen && hasLegacy) {
    return <LegacyForderungen f={f} hasArbeitnehmer={hasArbeitnehmer} />;
  }

  let lfdNr = 0;

  return (
    <>
      {/* ─── Summary Bar ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card mb-2.5 p-3 px-4 flex flex-wrap items-center gap-3">
        <SummaryBox label="Gesamtforderungen" value={gesamtVal ?? computedTotal} color="red" />
        <SummaryBox label="Gesichert" value={gesichertVal} color="amber" />
        <SummaryBox label="Ungesichert" value={ungesichertVal} color="muted" />
        <div className="flex-1" />
        <span className="text-[9px] text-text-dim font-mono">
          {einzelforderungen.length} Gläubiger
        </span>
      </div>

      {/* ─── Gläubigerverzeichnis ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="bg-bg border-b border-border">
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal w-8">Nr.</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal">Gläubiger</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal hidden sm:table-cell">Rechtsgrund</th>
              <th className="text-right py-2 px-2 text-[9px] text-text-dim font-normal w-28">Betrag</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-10">Rang</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-10">Ref</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(({ art, items }) => {
              const groupTotal = items.reduce((s, ef) => s + safeWert(ef.betrag), 0);
              return (
                <GroupRows
                  key={art}
                  art={art}
                  items={items}
                  startNr={lfdNr + 1}
                  groupTotal={groupTotal}
                  onRendered={(count) => { lfdNr += count; }}
                />
              );
            })}

            {/* Gesamtsumme */}
            <tr className="border-t-2 border-accent bg-bg">
              <td colSpan={3} className="py-2.5 px-2 text-xs font-bold text-text text-right">
                Summe aller Forderungen
              </td>
              <td className="py-2.5 px-2 text-right text-xs font-bold text-ie-red whitespace-nowrap">
                {EUR.format(gesamtVal ?? computedTotal)}
              </td>
              <td />
              <td className="py-2.5 px-2 text-center">
                {f?.gesamtforderungen?.quelle && (
                  <QuelleButton
                    quelle={f.gesamtforderungen.quelle}
                    searchText={(gesamtVal ?? computedTotal).toLocaleString('de-DE', { minimumFractionDigits: 2 })}
                  />
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ─── Betroffene Arbeitnehmer ─── */}
      {hasArbeitnehmer && <ArbeitnehmerSection arbeitnehmer={f.betroffene_arbeitnehmer} />}
    </>
  );
}

// ─── Group rows (header + items + subtotal) ───

function GroupRows({
  art, items, startNr, groupTotal, onRendered,
}: {
  art: ForderungsArt;
  items: Einzelforderung[];
  startNr: number;
  groupTotal: number;
  onRendered: (count: number) => void;
}) {
  // Call onRendered synchronously during render (safe for counter)
  onRendered(items.length);

  return (
    <>
      {/* Group header */}
      <tr className="bg-bg/50">
        <td colSpan={6} className="py-1.5 px-2 text-[9px] text-text-dim font-bold uppercase tracking-wider border-t border-border">
          {ART_LABELS[art]}
          <span className="ml-2 text-text-muted font-normal">({items.length})</span>
        </td>
      </tr>

      {/* Individual rows */}
      {items.map((ef, i) => {
        const nr = startNr + i;
        const rang = RANG_SHORT[ef.rang] || RANG_SHORT['§38 Insolvenzforderung'];
        const betrag = safeWert(ef.betrag) || null;
        const quelle = ef.betrag?.quelle || ef.glaeubiger?.quelle || '';
        const titel = ef.titel?.wert;
        const sicherheit = ef.sicherheit;
        const glaeubiger = ef.glaeubiger?.wert || '—';
        const zeitraumVon = ef.zeitraum_von?.wert;
        const zeitraumBis = ef.zeitraum_bis?.wert;

        return (
          <tr key={i} className="border-t border-border/50 hover:bg-surface-high/30 transition-colors group">
            {/* Nr. */}
            <td className="py-1.5 px-2 text-text-dim text-center align-top">{nr}</td>

            {/* Gläubiger */}
            <td className="py-1.5 px-2 align-top">
              <div className="flex items-center gap-1.5">
                <span className="text-text">{glaeubiger}</span>
                {ef.ist_antragsteller && (
                  <span className="px-1 py-px rounded-md border border-ie-blue/30 bg-ie-blue/10 text-ie-blue text-[7px] font-bold flex-shrink-0">
                    A
                  </span>
                )}
              </div>
              {/* Zeitraum unter Gläubiger (kompakt) */}
              {(zeitraumVon || zeitraumBis) && (
                <div className="text-[9px] text-text-muted mt-0.5">
                  {zeitraumVon || '?'} — {zeitraumBis || '?'}
                </div>
              )}
            </td>

            {/* Rechtsgrund */}
            <td className="py-1.5 px-2 text-text-muted align-top hidden sm:table-cell">
              {titel && <div>{titel}</div>}
              {sicherheit && (
                <div className="text-[9px] text-ie-amber mt-0.5 flex items-center gap-1">
                  <span>⚡</span>
                  <span>{SICHERHEIT_LABELS[sicherheit.art] || sicherheit.art}</span>
                  {sicherheit.gegenstand?.wert && (
                    <span className="text-text-muted">({sicherheit.gegenstand.wert})</span>
                  )}
                  {getNum(sicherheit.geschaetzter_wert) != null && (
                    <span className="text-text-muted">~{EUR.format(getNum(sicherheit.geschaetzter_wert)!)}</span>
                  )}
                </div>
              )}
            </td>

            {/* Betrag */}
            <td className="py-1.5 px-2 text-right text-text whitespace-nowrap align-top">
              {betrag != null ? EUR.format(betrag) : '—'}
            </td>

            {/* Rang */}
            <td className={`py-1.5 px-2 text-center align-top text-[9px] font-bold ${rang.className}`}>
              {rang.label}
            </td>

            {/* Quelle */}
            <td className="py-1.5 px-2 text-center align-top">
              <QuelleButton
                quelle={quelle}
                searchText={betrag ? betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 }) : glaeubiger}
              />
            </td>
          </tr>
        );
      })}

      {/* Group subtotal (only if >1 item) */}
      {items.length > 1 && (
        <tr className="border-t border-border/30 bg-bg/30">
          <td colSpan={3} className="py-1 px-2 text-[9px] text-text-dim text-right italic">
            Zwischensumme {ART_LABELS[art]}
          </td>
          <td className="py-1 px-2 text-right text-[10px] text-text-muted font-bold whitespace-nowrap">
            {EUR.format(groupTotal)}
          </td>
          <td colSpan={2} />
        </tr>
      )}
    </>
  );
}

// ─── Summary box ───

function SummaryBox({ label, value, color }: { label: string; value: number | null; color: 'red' | 'amber' | 'muted' }) {
  const colorMap = {
    red: { border: 'border-ie-red/30 bg-ie-red/5', text: 'text-ie-red' },
    amber: { border: 'border-amber-400/30 bg-amber-400/5', text: 'text-amber-400' },
    muted: { border: 'border-border bg-bg', text: 'text-text-muted' },
  };
  const c = colorMap[color];
  return (
    <div className={`flex flex-col items-center px-3 py-1.5 rounded-md border ${c.border}`}>
      <span className="text-[9px] text-text-dim font-sans">{label}</span>
      <span className={`text-sm font-bold font-mono ${c.text}`}>
        {value !== null && !isNaN(value) ? EUR.format(value) : '—'}
      </span>
    </div>
  );
}

// ─── Legacy fallback ───

function LegacyForderungen({ f, hasArbeitnehmer }: { f: Forderungen; hasArbeitnehmer: boolean }) {
  const legacyGesamtVal = getNum(f?.gesamtforderung) ?? getNum(f?.gesamtforderungen);
  return (
    <>
      <Section title="Forderungsaufstellung" icon="€">
        <DataField label="SV-Beiträge" field={f?.hauptforderung_beitraege} isCurrency fieldPath="forderungen.hauptforderung_beitraege" />
        <DataField label="Säumniszuschläge" field={f?.saeumniszuschlaege} isCurrency fieldPath="forderungen.saeumniszuschlaege" />
        <DataField label="Mahngebühren" field={f?.mahngebuehren} isCurrency fieldPath="forderungen.mahngebuehren" />
        <DataField label="Vollstreckungskosten" field={f?.vollstreckungskosten} isCurrency fieldPath="forderungen.vollstreckungskosten" />
        <DataField label="Antragskosten" field={f?.antragskosten} isCurrency fieldPath="forderungen.antragskosten" />
        <div className="flex justify-between items-center gap-4 py-2.5 border-t-2 border-accent mt-1.5">
          <span className="text-xs font-bold text-text">Gesamtforderung</span>
          <span className="text-sm font-bold text-ie-red whitespace-nowrap">
            {legacyGesamtVal != null ? EUR.format(legacyGesamtVal) : '—'}
          </span>
        </div>
      </Section>
      <Section title="Zeitraum & laufende Kosten" icon="◷">
        <DataField label="Zeitraum von" field={f?.zeitraum_von} fieldPath="forderungen.zeitraum_von" />
        <DataField label="Zeitraum bis" field={f?.zeitraum_bis} fieldPath="forderungen.zeitraum_bis" />
        <DataField label="Laufende mtl. Beiträge" field={f?.laufende_monatliche_beitraege} isCurrency fieldPath="forderungen.laufende_monatliche_beitraege" />
      </Section>
      {hasArbeitnehmer && <ArbeitnehmerSection arbeitnehmer={f.betroffene_arbeitnehmer} />}
    </>
  );
}

// ─── Arbeitnehmer section ───

function ArbeitnehmerSection({ arbeitnehmer }: { arbeitnehmer: Forderungen['betroffene_arbeitnehmer'] }) {
  return (
    <Section title="Betroffene Arbeitnehmer" icon="▣" count={arbeitnehmer.length} defaultOpen={false}>
      {arbeitnehmer.map((a, i) => {
        if (typeof a === 'string') return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{a}</div>;
        if (a && typeof a === 'object') {
          const o = a as Record<string, unknown>;
          if ('anzahl' in o && 'typ' in o) {
            const quelleStr = String(o.quelle ?? '');
            return (
              <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border text-[11px] text-text-dim">
                <span className="flex-1">
                  <span className="font-mono text-ie-blue">{String(o.anzahl ?? '')}</span>
                  {' \u00d7 '}
                  {String(o.typ ?? '')}
                </span>
                {quelleStr && (
                  <QuelleButton
                    quelle={quelleStr}
                    searchText={String(o.anzahl ?? '')}
                  />
                )}
              </div>
            );
          }
          if ('wert' in o) return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{String(o.wert)}</div>;
        }
        return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{String(a)}</div>;
      })}
    </Section>
  );
}
