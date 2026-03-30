import { useMemo } from 'react';
import { DataField } from '../DataField';
import { Section } from '../Section';
import type {
  Ermittlungsergebnisse,
  Gutachterbestellung,
  Standardanschreiben,
  FehlendInfo,
  AnschreibenStatus,
} from '../../../types/extraction';

// ─── Investigation line definitions ───

interface ErmittlungLine {
  id: string;
  label: string;
  letterType: string | null;
  resultPath: string | null;
}

const ERMITTLUNG_LINES: ErmittlungLine[] = [
  { id: 'grundbuch', label: 'Grundbuch', letterType: null, resultPath: 'grundbuch' },
  { id: 'kfz_zulassung', label: 'KFZ (Zulassungsstelle)', letterType: 'KFZ-Halteranfrage Zulassungsstelle', resultPath: null },
  { id: 'kfz_kba', label: 'KFZ (KBA)', letterType: 'KFZ-Halteranfrage KBA', resultPath: null },
  { id: 'gerichtsvollzieher', label: 'Gerichtsvollzieher', letterType: 'Gerichtsvollzieher-Anfrage', resultPath: 'gerichtsvollzieher' },
  { id: 'finanzamt', label: 'Finanzamt', letterType: 'Finanzamt-Anfrage', resultPath: null },
  { id: 'banken', label: 'Banken', letterType: 'Bankenauskunft', resultPath: null },
  { id: 'bausparkassen', label: 'Bausparkassen', letterType: 'Bausparkassen-Anfrage', resultPath: null },
  { id: 'versicherung', label: 'Versicherungen', letterType: 'Versicherungsanfrage', resultPath: null },
  { id: 'steuerberater', label: 'Steuerberater', letterType: 'Steuerberater-Kontakt', resultPath: null },
  { id: 'gewerbe', label: 'Gewerbe', letterType: 'Gewerbeauskunft', resultPath: null },
  { id: 'strafakte', label: 'Strafakte', letterType: 'Strafakte-Akteneinsicht', resultPath: null },
  { id: 'meldeauskunft', label: 'Meldeauskunft', letterType: null, resultPath: 'meldeauskunft' },
  { id: 'vollstreckungsportal', label: 'Vollstreckungsportal', letterType: null, resultPath: 'vollstreckungsportal' },
];

// ─── Status badge rendering ───

const STATUS_STYLES: Record<AnschreibenStatus, { bg: string; label: string }> = {
  bereit: { bg: 'bg-ie-green/10 text-ie-green border-ie-green/30', label: 'bereit' },
  fehlt: { bg: 'bg-ie-amber/10 text-ie-amber border-ie-amber/30', label: 'fehlt' },
  entfaellt: { bg: 'bg-bg text-text-muted border-border', label: 'entfaellt' },
};

function StatusBadge({ letter }: { letter: Standardanschreiben | undefined }) {
  if (!letter) {
    return <span className="text-text-muted">{'\u2014'}</span>;
  }

  const st = letter.status || 'fehlt';
  const style = STATUS_STYLES[st] || STATUS_STYLES.fehlt;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block px-1.5 py-0.5 rounded-sm text-[8px] font-bold tracking-wide border font-mono ${style.bg}`}>
        {style.label}
      </span>
      {st === 'bereit' && <span className="text-ie-green text-[9px]">{'\u2713'}</span>}
      {st === 'fehlt' && letter.fehlende_daten?.length > 0 && (
        <span className="text-[8px] text-ie-amber truncate max-w-[120px]" title={letter.fehlende_daten.join(', ')}>
          {letter.fehlende_daten[0]}{letter.fehlende_daten.length > 1 ? ` +${letter.fehlende_daten.length - 1}` : ''}
        </span>
      )}
    </div>
  );
}

// ─── Result rendering helpers ───

function boolLabel(val: { wert: boolean | null } | null | undefined): string {
  if (!val || val.wert === null || val.wert === undefined) return '';
  return val.wert ? 'Ja' : 'Nein';
}

function ResultCell({ line, e }: { line: ErmittlungLine; e: Ermittlungsergebnisse }) {
  if (!line.resultPath) {
    return <span className="text-text-muted">{'\u2014'}</span>;
  }

  switch (line.resultPath) {
    case 'grundbuch': {
      const gb = e?.grundbuch;
      if (!gb) return <span className="text-text-muted">{'\u2014'}</span>;
      const vorhanden = gb.grundbesitz_vorhanden?.wert;
      const text = vorhanden === true ? 'Grundbesitz vorhanden'
        : vorhanden === false ? 'Kein Grundbesitz'
        : gb.ergebnis?.wert || '\u2014';
      return (
        <span className={`text-[10px] ${vorhanden === true ? 'text-ie-amber' : vorhanden === false ? 'text-ie-green' : 'text-text-muted'}`}>
          {text}
        </span>
      );
    }

    case 'gerichtsvollzieher': {
      const gv = e?.gerichtsvollzieher;
      if (!gv) return <span className="text-text-muted">{'\u2014'}</span>;
      const parts: string[] = [];
      if (gv.masse_deckend?.wert !== null && gv.masse_deckend?.wert !== undefined) {
        parts.push(`Masse ${gv.masse_deckend.wert ? 'deckend' : 'nicht deckend'}`);
      }
      if (gv.haftbefehle?.wert === true) parts.push('Haftbefehle');
      if (gv.vermoegensauskunft_abgegeben?.wert === true) parts.push('VE abgegeben');
      return (
        <span className="text-[10px] text-text-muted">
          {parts.length > 0 ? parts.join(' · ') : (gv.vollstreckungen?.wert || '\u2014')}
        </span>
      );
    }

    case 'vollstreckungsportal': {
      const vp = e?.vollstreckungsportal;
      if (!vp) return <span className="text-text-muted">{'\u2014'}</span>;
      const sv = boolLabel(vp.schuldnerverzeichnis_eintrag);
      const vv = boolLabel(vp.vermoegensverzeichnis_eintrag);
      if (!sv && !vv) return <span className="text-text-muted">{'\u2014'}</span>;
      return (
        <span className="text-[10px] text-text-muted">
          {sv && `SV: ${sv}`}{sv && vv && ' · '}{vv && `VV: ${vv}`}
        </span>
      );
    }

    case 'meldeauskunft': {
      const ma = e?.meldeauskunft;
      if (!ma) return <span className="text-text-muted">{'\u2014'}</span>;
      return (
        <span className="text-[10px] text-text-muted">
          {ma.meldestatus?.wert || '\u2014'}
        </span>
      );
    }

    default:
      return <span className="text-text-muted">{'\u2014'}</span>;
  }
}

function DetailCell({ line, e }: { line: ErmittlungLine; e: Ermittlungsergebnisse }) {
  if (!line.resultPath) return <span className="text-text-muted">{'\u2014'}</span>;

  const getQuelle = (): string => {
    switch (line.resultPath) {
      case 'grundbuch': return e?.grundbuch?.ergebnis?.quelle || e?.grundbuch?.datum?.quelle || '';
      case 'gerichtsvollzieher': return e?.gerichtsvollzieher?.vollstreckungen?.quelle || e?.gerichtsvollzieher?.name?.quelle || '';
      case 'vollstreckungsportal': return e?.vollstreckungsportal?.schuldnerverzeichnis_eintrag?.quelle || '';
      case 'meldeauskunft': return e?.meldeauskunft?.meldestatus?.quelle || '';
      default: return '';
    }
  };

  const quelle = getQuelle();
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  if (!match) return <span className="text-text-muted">{'\u2014'}</span>;

  return (
    <span className="text-[8px] font-mono text-ie-blue" title={quelle}>
      S.{match[1]}
    </span>
  );
}

// ─── Main component ───

interface ErmittlungTabProps {
  ermittlungsergebnisse: Ermittlungsergebnisse;
  gutachterbestellung: Gutachterbestellung;
  letters: Standardanschreiben[];
  missingInfo: FehlendInfo[];
}

export function ErmittlungTab({ ermittlungsergebnisse: e, gutachterbestellung: g, letters, missingInfo }: ErmittlungTabProps) {
  const letterMap = useMemo(() => {
    const map = new Map<string, Standardanschreiben>();
    for (const l of letters) {
      map.set(l.typ, l);
    }
    return map;
  }, [letters]);

  // Count summary
  const summary = useMemo(() => {
    let bereit = 0, fehlt = 0, entfaellt = 0, noLetter = 0;
    for (const line of ERMITTLUNG_LINES) {
      if (!line.letterType) { noLetter++; continue; }
      const letter = letterMap.get(line.letterType);
      if (!letter) { noLetter++; continue; }
      if (letter.status === 'bereit') bereit++;
      else if (letter.status === 'fehlt') fehlt++;
      else entfaellt++;
    }
    return { bereit, fehlt, entfaellt, noLetter };
  }, [letterMap]);

  return (
    <>
      {/* ─── Summary ─── */}
      <div className="bg-surface border border-border rounded-sm mb-2.5 p-3 px-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-col items-center px-3 py-1.5 rounded-sm border border-ie-green/30 bg-ie-green/5">
          <span className="text-[9px] text-text-dim font-sans">Bereit</span>
          <span className="text-sm font-bold font-mono text-ie-green">{summary.bereit}</span>
        </div>
        <div className="flex flex-col items-center px-3 py-1.5 rounded-sm border border-ie-amber/30 bg-ie-amber/5">
          <span className="text-[9px] text-text-dim font-sans">Fehlt</span>
          <span className="text-sm font-bold font-mono text-ie-amber">{summary.fehlt}</span>
        </div>
        <div className="flex flex-col items-center px-3 py-1.5 rounded-sm border border-border bg-bg">
          <span className="text-[9px] text-text-dim font-sans">Entfaellt</span>
          <span className="text-sm font-bold font-mono text-text-muted">{summary.entfaellt}</span>
        </div>
        <div className="flex-1" />
        <span className="text-[9px] text-text-dim font-mono">
          {ERMITTLUNG_LINES.length} Ermittlungslinien
        </span>
      </div>

      {/* ─── Investigation Lines Table ─── */}
      <div className="bg-surface border border-border rounded-sm overflow-hidden mb-2.5">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="bg-bg border-b border-border">
              <th className="text-left py-2 px-3 text-[9px] text-text-dim font-normal">Ermittlung</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal w-44">Anfrage-Status</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal">Ergebnis</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-12">Ref</th>
            </tr>
          </thead>
          <tbody>
            {ERMITTLUNG_LINES.map((line) => {
              const letter = line.letterType ? letterMap.get(line.letterType) : undefined;
              return (
                <tr key={line.id} className="border-t border-border/50 hover:bg-bg/30 transition-colors">
                  {/* Ermittlung label */}
                  <td className="py-1.5 px-3 text-text font-sans text-[11px]">
                    {line.label}
                  </td>

                  {/* Anfrage-Status */}
                  <td className="py-1.5 px-2">
                    <StatusBadge letter={letter} />
                  </td>

                  {/* Ergebnis */}
                  <td className="py-1.5 px-2">
                    <ResultCell line={line} e={e} />
                  </td>

                  {/* Detail / Ref */}
                  <td className="py-1.5 px-2 text-center">
                    <DetailCell line={line} e={e} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── Gutachterbestellung ─── */}
      <Section title="Gutachterbestellung" icon="◊">
        <DataField label="Gutachter" field={g?.gutachter_name} fieldPath="gutachterbestellung.gutachter_name" />
        <DataField label="Kanzlei" field={g?.gutachter_kanzlei} fieldPath="gutachterbestellung.gutachter_kanzlei" />
        <DataField label="Adresse" field={g?.gutachter_adresse} fieldPath="gutachterbestellung.gutachter_adresse" />
        <DataField label="Telefon" field={g?.gutachter_telefon} fieldPath="gutachterbestellung.gutachter_telefon" />
        <DataField label="E-Mail" field={g?.gutachter_email} fieldPath="gutachterbestellung.gutachter_email" />
        <DataField label="Abgabefrist" field={g?.abgabefrist} fieldPath="gutachterbestellung.abgabefrist" />
        {g?.befugnisse?.length > 0 && (
          <div className="mt-2">
            <span className="text-[11px] text-text-dim">Befugnisse:</span>
            <ul className="mt-1 ml-4 list-disc">
              {g.befugnisse.map((b, i) => (
                <li key={i} className="text-xs text-text py-0.5">{b}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* ─── Fehlende Informationen ─── */}
      {missingInfo.length > 0 && (
        <Section title="Fehlende Informationen" icon="△" count={missingInfo.length} defaultOpen={false}>
          {missingInfo.map((m, i) => {
            const title = typeof m === 'string' ? m : (m.information || m.grund || m.ermittlung_ueber || 'Fehlende Angabe').trim();
            const titleFromGrund = typeof m === 'object' && !m.information?.trim() && m.grund?.trim() === title;
            return (
              <div key={i} className="p-2.5 px-3 mb-1.5 bg-ie-red-bg border border-ie-red-border rounded-sm">
                <div className="text-xs text-text font-semibold font-sans">{title}</div>
                {typeof m === 'object' && m.grund && !titleFromGrund && (
                  <div className="text-[10px] text-text-dim mt-0.5">Grund: {m.grund}</div>
                )}
                {typeof m === 'object' && m.ermittlung_ueber && (
                  <div className="text-[10px] text-ie-amber mt-0.5">{'\u2192'} Ermittlung ueber: {m.ermittlung_ueber}</div>
                )}
              </div>
            );
          })}
        </Section>
      )}
    </>
  );
}
