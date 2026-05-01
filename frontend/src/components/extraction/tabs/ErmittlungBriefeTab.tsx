import { Fragment, useEffect, useMemo, useState } from 'react';
import { Section } from '../Section';
import { apiClient } from '../../../api/client';
import { StrafakteInputsModal } from '../StrafakteInputsModal';
import { useVerwalter } from '../../../hooks/useVerwalter';
import { usePdf } from '../../../contexts/PdfContext';
import { findMatchingVerwalter, normalizeVerwalterName } from '../../../utils/matchVerwalter';
import type {
  ExtractionResult,
  Ermittlungsergebnisse,
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
    return <span className="text-text-muted">{'—'}</span>;
  }
  const st = letter.status || 'fehlt';
  const style = STATUS_STYLES[st] || STATUS_STYLES.fehlt;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded-md text-[8px] font-bold tracking-wide border font-mono ${style.bg}`}>
      {style.label}
    </span>
  );
}

// ─── Result cell (reused from old ErmittlungTab) ───

function boolLabel(val: { wert: boolean | null } | null | undefined): string {
  if (!val || val.wert === null || val.wert === undefined) return '';
  return val.wert ? 'Ja' : 'Nein';
}

function ResultCell({ line, e }: { line: ErmittlungLine; e: Ermittlungsergebnisse }) {
  if (!line.resultPath) {
    return <span className="text-text-muted">{'—'}</span>;
  }
  switch (line.resultPath) {
    case 'grundbuch': {
      const gb = e?.grundbuch;
      if (!gb) return <span className="text-text-muted">{'—'}</span>;
      const vorhanden = gb.grundbesitz_vorhanden?.wert;
      const text = vorhanden === true ? 'Grundbesitz vorhanden'
        : vorhanden === false ? 'Kein Grundbesitz'
        : gb.ergebnis?.wert || '—';
      return (
        <span className={`text-[10px] ${vorhanden === true ? 'text-ie-amber' : vorhanden === false ? 'text-ie-green' : 'text-text-muted'}`}>
          {text}
        </span>
      );
    }
    case 'gerichtsvollzieher': {
      const gv = e?.gerichtsvollzieher;
      if (!gv) return <span className="text-text-muted">{'—'}</span>;
      const parts: string[] = [];
      if (gv.masse_deckend?.wert !== null && gv.masse_deckend?.wert !== undefined) {
        parts.push(`Masse ${gv.masse_deckend.wert ? 'deckend' : 'nicht deckend'}`);
      }
      if (gv.haftbefehle?.wert === true) parts.push('Haftbefehle');
      if (gv.vermoegensauskunft_abgegeben?.wert === true) parts.push('VE abgegeben');
      return (
        <span className="text-[10px] text-text-muted">
          {parts.length > 0 ? parts.join(' · ') : (gv.vollstreckungen?.wert || '—')}
        </span>
      );
    }
    case 'vollstreckungsportal': {
      const vp = e?.vollstreckungsportal;
      if (!vp) return <span className="text-text-muted">{'—'}</span>;
      const sv = boolLabel(vp.schuldnerverzeichnis_eintrag);
      const vv = boolLabel(vp.vermoegensverzeichnis_eintrag);
      if (!sv && !vv) return <span className="text-text-muted">{'—'}</span>;
      return (
        <span className="text-[10px] text-text-muted">
          {sv && `SV: ${sv}`}{sv && vv && ' · '}{vv && `VV: ${vv}`}
        </span>
      );
    }
    case 'meldeauskunft': {
      const ma = e?.meldeauskunft;
      if (!ma) return <span className="text-text-muted">{'—'}</span>;
      return (
        <span className="text-[10px] text-text-muted">
          {ma.meldestatus?.wert || '—'}
        </span>
      );
    }
    default:
      return <span className="text-text-muted">{'—'}</span>;
  }
}

function detailQuelle(line: ErmittlungLine, e: Ermittlungsergebnisse): string {
  if (!line.resultPath) return '';
  switch (line.resultPath) {
    case 'grundbuch': return e?.grundbuch?.ergebnis?.quelle || e?.grundbuch?.datum?.quelle || '';
    case 'gerichtsvollzieher': return e?.gerichtsvollzieher?.vollstreckungen?.quelle || e?.gerichtsvollzieher?.name?.quelle || '';
    case 'vollstreckungsportal': return e?.vollstreckungsportal?.schuldnerverzeichnis_eintrag?.quelle || '';
    case 'meldeauskunft': return e?.meldeauskunft?.meldestatus?.quelle || '';
    default: return '';
  }
}

// ─── Main component ───

interface ErmittlungBriefeTabProps {
  result: ExtractionResult;
  ermittlungsergebnisse: Ermittlungsergebnisse;
  letters: Standardanschreiben[];
  missingInfo: FehlendInfo[];
  extractionId: number | null;
}

export function ErmittlungBriefeTab({
  result,
  ermittlungsergebnisse: e,
  letters,
  missingInfo,
  extractionId,
}: ErmittlungBriefeTabProps) {
  const { goToPageAndHighlight, totalPages } = usePdf();
  const letterMap = useMemo(() => {
    const map = new Map<string, Standardanschreiben>();
    for (const l of letters) map.set(l.typ, l);
    return map;
  }, [letters]);

  // Summary
  const summary = useMemo(() => {
    let bereit = 0, fehlt = 0, entfaellt = 0;
    for (const l of letters) {
      if (l.status === 'bereit') bereit++;
      else if (l.status === 'entfaellt') entfaellt++;
      else fehlt++;
    }
    return { bereit, fehlt, entfaellt };
  }, [letters]);

  // Expanded rows
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Verwalter picker
  const { profiles, loading: loadingProfiles } = useVerwalter();
  const [selectedVerwalterId, setSelectedVerwalterId] = useState<number | null>(null);
  const [autoSelectedOnce, setAutoSelectedOnce] = useState(false);
  const extractedGutachterName = result?.gutachterbestellung?.gutachter_name?.wert ?? null;

  useEffect(() => {
    if (autoSelectedOnce || loadingProfiles) return;
    if (selectedVerwalterId !== null) return;
    const match = findMatchingVerwalter(profiles, extractedGutachterName);
    if (match) setSelectedVerwalterId(match.id);
    setAutoSelectedOnce(true);
  }, [profiles, loadingProfiles, extractedGutachterName, selectedVerwalterId, autoSelectedOnce]);

  const selectedVerwalter = useMemo(
    () => profiles.find(p => p.id === selectedVerwalterId) ?? null,
    [profiles, selectedVerwalterId],
  );

  const canGenerate = selectedVerwalterId !== null;
  const [strafaktePending, setStrafaktePending] = useState<string | null>(null);

  async function handleGenerate(typ: string, extras: Record<string, string> = {}) {
    if (!extractionId) return;
    if (!selectedVerwalterId) {
      alert('Bitte zuerst einen Verwalter auswählen.');
      return;
    }
    if (typ.toLowerCase().includes('strafakte') && Object.keys(extras).length === 0) {
      setStrafaktePending(typ);
      return;
    }
    try {
      const response = await apiClient.post(
        `/generate-letter/${extractionId}/${encodeURIComponent(typ)}`,
        { verwalterId: selectedVerwalterId, extras },
        { responseType: 'blob' },
      );
      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${typ.replace(/[^\w-]/g, '_')}_${extractionId}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      const axErr = err as { response?: { data?: Blob; status?: number } };
      let msg = 'Generierung fehlgeschlagen';
      if (axErr?.response?.data instanceof Blob) {
        try {
          const text = await axErr.response.data.text();
          const parsed = JSON.parse(text);
          msg = parsed.error ?? msg;
          if (parsed.code === 'VERWALTER_REQUIRED') {
            msg += ' Tipp: Nutze den Gutachten-Assistenten, um einen Verwalter zuzuweisen.';
          }
        } catch { /* swallow parse errors */ }
      }
      alert(msg);
    }
  }

  return (
    <>
      {/* ─── Summary ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card mb-3 p-3 px-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-ie-green/30 bg-ie-green/5">
          <span className="text-[9px] text-text-dim font-sans">Bereit</span>
          <span className="text-sm font-bold font-mono text-ie-green">{summary.bereit}</span>
        </div>
        <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-ie-amber/30 bg-ie-amber/5">
          <span className="text-[9px] text-text-dim font-sans">Fehlt</span>
          <span className="text-sm font-bold font-mono text-ie-amber">{summary.fehlt}</span>
        </div>
        <div className="flex flex-col items-center px-3 py-1.5 rounded-md border border-border/60 bg-bg">
          <span className="text-[9px] text-text-dim font-sans">Entfaellt</span>
          <span className="text-sm font-bold font-mono text-text-muted">{summary.entfaellt}</span>
        </div>
        <div className="flex-1" />
        <span className="text-[9px] text-text-dim font-mono">
          {ERMITTLUNG_LINES.length} Ermittlungslinien
        </span>
      </div>

      {/* ─── Verwalter-Picker ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card p-3 mb-3.5">
        <label className="text-[10px] text-text-dim block mb-1 uppercase tracking-wide">
          Verwalter/in für Anschreiben *
        </label>
        <select
          value={selectedVerwalterId ?? ''}
          onChange={(e) => setSelectedVerwalterId(e.target.value ? parseInt(e.target.value, 10) : null)}
          className="w-full text-xs border border-border rounded px-2 py-1.5 bg-bg"
          disabled={loadingProfiles}
        >
          <option value="">— bitte auswählen —</option>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}{p.standort ? ` (${p.standort})` : ''}
            </option>
          ))}
        </select>
        {selectedVerwalter && (
          <div className="text-[10px] text-text-dim mt-1">
            {extractedGutachterName && normalizeVerwalterName(extractedGutachterName).split(' ').some(t => t.length >= 3 && normalizeVerwalterName(selectedVerwalter.name).includes(t))
              ? '✓ Anhand des Bestellungsbeschlusses vorausgewählt'
              : 'Manuell gewählt'}
            {' · Diktatzeichen: '}{selectedVerwalter.diktatzeichen || '—'}
            {' · Geschlecht: '}{selectedVerwalter.geschlecht === 'weiblich' ? 'weiblich' : 'männlich'}
          </div>
        )}
        {!selectedVerwalter && !loadingProfiles && profiles.length === 0 && (
          <div className="text-[10px] text-ie-amber mt-1">
            Keine Verwalter-Profile vorhanden — bitte in den Einstellungen anlegen.
          </div>
        )}
      </div>

      {/* ─── Investigation Lines Table ─── */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card overflow-hidden mb-3">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="bg-bg border-b border-border">
              <th className="text-left py-2 px-3 text-[9px] text-text-dim font-normal">Ermittlung</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal w-24">Status</th>
              <th className="text-left py-2 px-2 text-[9px] text-text-dim font-normal">Ergebnis</th>
              <th className="text-center py-2 px-2 text-[9px] text-text-dim font-normal w-12">Ref</th>
              <th className="text-right py-2 px-3 text-[9px] text-text-dim font-normal w-32">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {ERMITTLUNG_LINES.map((line) => {
              const letter = line.letterType ? letterMap.get(line.letterType) : undefined;
              const quelle = detailQuelle(line, e);
              const pageMatch = quelle ? quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i) : null;
              const isExpanded = expanded.has(line.id);
              const hasDetail = !!(letter?.begruendung || (letter?.fehlende_daten && letter.fehlende_daten.length > 0));
              const canGenerateRow = letter?.status === 'bereit' && extractionId != null;

              return (
                <Fragment key={line.id}>
                  <tr
                    className={`border-t border-border/50 hover:bg-bg/30 transition-colors ${hasDetail ? 'cursor-pointer' : ''}`}
                    onClick={() => hasDetail && toggle(line.id)}
                  >
                    {/* Label */}
                    <td className="py-1.5 px-3 text-text font-sans text-[11px]">
                      <span className="flex items-center gap-1.5">
                        {hasDetail && (
                          <span className={`text-[8px] text-text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                        )}
                        {line.label}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="py-1.5 px-2">
                      <StatusBadge letter={letter} />
                    </td>

                    {/* Ergebnis */}
                    <td className="py-1.5 px-2">
                      <ResultCell line={line} e={e} />
                    </td>

                    {/* Ref */}
                    <td className="py-1.5 px-2 text-center">
                      {pageMatch ? (
                        <button
                          type="button"
                          disabled={totalPages === 0}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            const pageNum = parseInt(pageMatch[1], 10);
                            if (totalPages > 0 && !isNaN(pageNum)) {
                              goToPageAndHighlight(pageNum, undefined, quelle);
                            }
                          }}
                          className="text-[8px] font-mono text-ie-blue hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                          title={totalPages === 0 ? 'PDF nicht geladen' : quelle}
                        >
                          S.{pageMatch[1]}
                        </button>
                      ) : (
                        <span className="text-text-muted">{'—'}</span>
                      )}
                    </td>

                    {/* Aktion */}
                    <td className="py-1.5 px-3 text-right">
                      {canGenerateRow ? (
                        <button
                          type="button"
                          disabled={!canGenerate}
                          title={!canGenerate ? 'Bitte zuerst Verwalter auswählen' : undefined}
                          className="text-[9px] px-2 py-1 rounded bg-ie-green text-white hover:bg-ie-green/90 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            if (canGenerate && letter) handleGenerate(letter.typ);
                          }}
                        >
                          DOCX
                        </button>
                      ) : (
                        <span className="text-text-muted">{'—'}</span>
                      )}
                    </td>
                  </tr>

                  {/* Expanded detail row */}
                  {isExpanded && hasDetail && (
                    <tr className="bg-bg/30">
                      <td colSpan={5} className="py-2 px-4">
                        {letter?.begruendung && (
                          <div className="text-[10px] text-text-dim mb-1">{letter.begruendung}</div>
                        )}
                        {letter?.fehlende_daten && letter.fehlende_daten.length > 0 && (
                          <div className="text-[10px] text-ie-amber">
                            Fehlend: {letter.fehlende_daten.join(', ')}
                          </div>
                        )}
                        {letter?.empfaenger && (
                          <div className="text-[10px] text-text-dim mt-1">
                            An: {letter.empfaenger}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── Fehlende Informationen ─── */}
      {missingInfo.length > 0 && (
        <Section title="Fehlende Informationen" icon="△" count={missingInfo.length} defaultOpen={false}>
          {missingInfo.map((m, i) => {
            const title = typeof m === 'string' ? m : (m.information || m.grund || m.ermittlung_ueber || 'Fehlende Angabe').trim();
            const titleFromGrund = typeof m === 'object' && !m.information?.trim() && m.grund?.trim() === title;
            return (
              <div key={i} className="p-2.5 px-3 mb-1.5 bg-ie-red-bg border border-ie-red-border rounded-md">
                <div className="text-xs text-text font-semibold font-sans">{title}</div>
                {typeof m === 'object' && m.grund && !titleFromGrund && (
                  <div className="text-[10px] text-text-dim mt-0.5">Grund: {m.grund}</div>
                )}
                {typeof m === 'object' && m.ermittlung_ueber && (
                  <div className="text-[10px] text-ie-amber mt-0.5">{'→'} Ermittlung ueber: {m.ermittlung_ueber}</div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {strafaktePending && (
        <StrafakteInputsModal
          typ={strafaktePending}
          onCancel={() => setStrafaktePending(null)}
          onSubmit={(extrasObj: Record<string, string>) => {
            const capturedTyp = strafaktePending;
            setStrafaktePending(null);
            if (capturedTyp) handleGenerate(capturedTyp, extrasObj);
          }}
        />
      )}
    </>
  );
}
