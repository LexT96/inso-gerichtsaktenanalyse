import { useState, useMemo } from 'react';
import { usePdf } from '../../../contexts/PdfContext';
import { EmptyState } from '../EmptyState';
import type { Anfechtungsanalyse, AnfechtungsRisiko, AnfechtbarerVorgang, Verfahrensdaten } from '../../../types/extraction';

const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

const RISIKO_ORDER: Record<AnfechtungsRisiko, number> = { hoch: 0, mittel: 1, gering: 2 };

const RISIKO_STYLES: Record<AnfechtungsRisiko, string> = {
  hoch: 'bg-red-400/10 text-red-400 border-red-400/30',
  mittel: 'bg-amber-400/10 text-amber-400 border-amber-400/30',
  gering: 'bg-bg text-text-muted border-border',
};

/** Extract short paragraph reference like "§130" from full Grundlage string */
function shortGrundlage(grundlage: string): string {
  const match = grundlage.match(/(§\d+)/);
  return match ? match[1] : grundlage;
}

function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

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

function VorgangRow({ vorgang, nr }: { vorgang: AnfechtbarerVorgang; nr: number }) {
  const [expanded, setExpanded] = useState(false);
  const risiko = vorgang.risiko || 'gering';
  const betrag = vorgang.betrag?.wert;
  const quelle = vorgang.betrag?.quelle || vorgang.beschreibung?.quelle || '';

  return (
    <>
      <tr
        className="border-t border-border/50 hover:bg-bg/30 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Nr. */}
        <td className="py-1.5 px-2 text-text-dim text-center align-top">{nr}</td>

        {/* Datum */}
        <td className="py-1.5 px-2 text-text-muted align-top whitespace-nowrap">
          {vorgang.datum?.wert || '\u2014'}
        </td>

        {/* Empfaenger */}
        <td className="py-1.5 px-2 align-top">
          <div className="flex items-center gap-1.5">
            <span className="text-text">{vorgang.empfaenger?.wert || '\u2014'}</span>
            {vorgang.ist_nahestehend && (
              <span className="px-1 py-px rounded-md border border-ie-blue/30 bg-ie-blue/10 text-ie-blue text-[7px] font-bold flex-shrink-0">
                §138
              </span>
            )}
          </div>
        </td>

        {/* Beschreibung */}
        <td className="py-1.5 px-2 text-text-muted align-top hidden sm:table-cell">
          <div className="text-[10px] leading-relaxed">{vorgang.beschreibung?.wert || '\u2014'}</div>
        </td>

        {/* Betrag */}
        <td className="py-1.5 px-2 text-right text-text whitespace-nowrap align-top">
          {betrag != null ? EUR.format(betrag) : '\u2014'}
        </td>

        {/* Grundlage */}
        <td className="py-1.5 px-2 text-center align-top">
          <span
            className="text-[9px] font-bold font-mono text-text-muted"
            title={vorgang.grundlage}
          >
            {shortGrundlage(vorgang.grundlage)}
          </span>
        </td>

        {/* Risiko */}
        <td className="py-1.5 px-2 text-center align-top">
          <span className={`inline-block px-2 py-0.5 rounded-md text-[9px] font-bold tracking-wide border font-mono ${RISIKO_STYLES[risiko]}`}>
            {risiko.toUpperCase()}
          </span>
        </td>

        {/* Frist */}
        <td className="py-1.5 px-2 text-text-muted text-center align-top whitespace-nowrap text-[10px]">
          {vorgang.anfechtbar_ab || '\u2014'}
        </td>

        {/* Ref */}
        <td className="py-1.5 px-2 text-center align-top">
          <QuelleButton
            quelle={quelle}
            searchText={betrag != null ? betrag.toLocaleString('de-DE', { minimumFractionDigits: 2 }) : vorgang.empfaenger?.wert || undefined}
          />
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && vorgang.begruendung && (
        <tr className="bg-bg/30">
          <td />
          <td colSpan={8} className="py-2 px-2">
            <div className="text-[10px] text-text-dim leading-relaxed italic">
              {vorgang.begruendung}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

interface AnfechtungTabProps {
  anfechtung?: Anfechtungsanalyse;
  verfahrensdaten: Verfahrensdaten;
}

export function AnfechtungTab({ anfechtung }: AnfechtungTabProps) {
  const vorgaenge = anfechtung?.vorgaenge ?? [];

  const sorted = useMemo(
    () => [...vorgaenge].sort((a, b) => (RISIKO_ORDER[a.risiko] ?? 2) - (RISIKO_ORDER[b.risiko] ?? 2)),
    [vorgaenge],
  );

  const risikoCount = useMemo(() => {
    const counts = { hoch: 0, mittel: 0, gering: 0 };
    for (const v of vorgaenge) {
      if (v.risiko in counts) counts[v.risiko]++;
    }
    return counts;
  }, [vorgaenge]);

  const gesamtpotenzial = anfechtung?.gesamtpotenzial?.wert ?? null;

  // Empty state
  if (!anfechtung || vorgaenge.length === 0) {
    return (
      <EmptyState
        icon="⚡"
        title="Keine anfechtbaren Vorgänge in der Akte identifiziert."
        description="Es wurden keine potenziell anfechtbaren Rechtshandlungen erkannt."
      />
    );
  }

  return (
    <>
      {/* ─── Summary Bar ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card mb-2.5 p-3 px-4">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          {/* Gesamtpotenzial */}
          <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-ie-red/30 bg-ie-red/5">
            <span className="text-[9px] text-text-dim font-sans">Gesamtpotenzial</span>
            <span className="text-sm font-bold font-mono text-ie-red">
              {gesamtpotenzial !== null ? EUR.format(gesamtpotenzial) : '\u2014'}
            </span>
          </div>

          {/* Risk counts */}
          <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-red-400/30 bg-red-400/5">
            <span className="text-[9px] text-text-dim font-sans">Hoch</span>
            <span className="text-sm font-bold font-mono text-red-400">{risikoCount.hoch}</span>
          </div>
          <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-amber-400/30 bg-amber-400/5">
            <span className="text-[9px] text-text-dim font-sans">Mittel</span>
            <span className="text-sm font-bold font-mono text-amber-400">{risikoCount.mittel}</span>
          </div>
          <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-border bg-bg">
            <span className="text-[9px] text-text-dim font-sans">Gering</span>
            <span className="text-sm font-bold font-mono text-text-muted">{risikoCount.gering}</span>
          </div>

          <div className="flex-1" />
          <span className="text-[9px] text-text-dim font-mono">
            {vorgaenge.length} Vorgaenge
          </span>
        </div>

        {/* AI summary */}
        {anfechtung.zusammenfassung && (
          <div className="text-[10px] text-text-muted leading-relaxed border-t border-border pt-2 mt-1">
            {anfechtung.zusammenfassung}
          </div>
        )}
      </div>

      {/* ─── Vorgaenge Table ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card overflow-x-auto">
        <table className="w-full text-[11px] font-mono min-w-[700px]">
          <thead>
            <tr className="bg-bg border-b border-border">
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal w-8">Nr.</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal w-20">Datum</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal">Empfaenger</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal hidden sm:table-cell">Beschreibung</th>
              <th className="text-right py-2 px-2 text-[9px] text-text-dim font-normal w-28">Betrag</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-12">Grundl.</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-16">Risiko</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-24">Anfecht. ab</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-10">Ref</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((v, i) => (
              <VorgangRow key={i} vorgang={v} nr={i + 1} />
            ))}

            {/* Total row */}
            <tr className="border-t-2 border-accent bg-bg">
              <td colSpan={4} className="py-2.5 px-2 text-xs font-bold text-text text-right">
                Gesamtpotenzial Anfechtung
              </td>
              <td className="py-2.5 px-2 text-right text-xs font-bold text-ie-red whitespace-nowrap">
                {gesamtpotenzial !== null ? EUR.format(gesamtpotenzial) : '\u2014'}
              </td>
              <td colSpan={4} />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
