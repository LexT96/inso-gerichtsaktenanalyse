import { useState } from 'react';
import { Badge } from '../Badge';
import { Section } from '../Section';
import { FieldChecklist } from '../FieldChecklist';
import { apiClient } from '../../../api/client';
import { StrafakteInputsModal } from '../StrafakteInputsModal';
import type { ExtractionResult, Standardanschreiben, FehlendInfo, Pruefstatus } from '../../../types/extraction';

interface LetterCardProps {
  letter: Standardanschreiben;
  extractionId: number | null;
  onGenerate: (typ: string) => void;
}

function LetterCard({ letter, extractionId, onGenerate }: LetterCardProps) {
  const [expanded, setExpanded] = useState(false);
  const st = letter.status || 'fehlt';

  const bgClass = st === 'bereit' ? 'bg-ie-green-bg border-ie-green-border'
    : st === 'entfaellt' ? 'bg-ie-blue-bg border-ie-blue-border'
    : 'bg-ie-amber-bg border-ie-amber-border';

  return (
    <div
      className={`border rounded-lg shadow-card p-2.5 px-3.5 mb-2 hover:shadow-card-hover transition-shadow ${bgClass}`}
    >
      <div className="flex justify-between items-center cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div>
          <div className="text-xs font-semibold text-text font-sans">{letter.typ}</div>
          <div className="text-[10px] text-text-dim mt-0.5">An: {letter.empfaenger?.trim() || '—'}</div>
        </div>
        <div className="flex items-center gap-2">
          {st === 'bereit' && extractionId != null && (
            <button
              type="button"
              className="text-[10px] px-2 py-1 rounded bg-ie-green text-white hover:bg-ie-green/90 font-medium"
              onClick={(e) => { e.stopPropagation(); onGenerate(letter.typ); }}
            >
              DOCX erzeugen
            </button>
          )}
          <Badge type={st} />
        </div>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border">
          {letter.begruendung && (
            <div className="text-[10px] text-text-dim mb-1">{letter.begruendung}</div>
          )}
          {letter.fehlende_daten?.length > 0 && (
            <div className="text-[10px] text-ie-amber">
              Fehlend: {letter.fehlende_daten.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface StatsCardSmallProps {
  label: string;
  value: number;
  colorClass: string;
}

function StatsCardSmall({ label, value, colorClass }: StatsCardSmallProps) {
  return (
    <div className="bg-surface border border-border/60 rounded-lg shadow-card py-3.5 px-4 text-center flex-1">
      <div className={`text-2xl font-bold font-mono ${colorClass}`}>{value}</div>
      <div className="text-[9px] text-text-muted mt-0.5 uppercase tracking-wide">{label}</div>
    </div>
  );
}

// All unique fields needed across all letter types
const ANSCHREIBEN_REQUIRED_FIELDS = [
  { path: 'verfahrensdaten.aktenzeichen', label: 'Aktenzeichen' },
  { path: 'verfahrensdaten.gericht', label: 'Gericht' },
  { path: 'verfahrensdaten.beschlussdatum', label: 'Beschlussdatum' },
  { path: 'schuldner.name', label: 'Schuldner Name' },
  { path: 'schuldner.vorname', label: 'Schuldner Vorname' },
  { path: 'schuldner.geburtsdatum', label: 'Geburtsdatum' },
  { path: 'schuldner.aktuelle_adresse', label: 'Aktuelle Adresse' },
  { path: 'schuldner.firma', label: 'Firma' },
  { path: 'schuldner.handelsregisternummer', label: 'Handelsregister-Nr.' },
  { path: 'schuldner.betriebsstaette_adresse', label: 'Betriebsstätte' },
];

interface AnschreibenTabProps {
  result: ExtractionResult;
  letters: Standardanschreiben[];
  missingInfo: FehlendInfo[];
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
  extractionId: number | null;
}

export function AnschreibenTab({ result, letters, missingInfo, onUpdateField, extractionId }: AnschreibenTabProps) {
  const bereit = letters.filter(l => l.status === 'bereit');
  const fehlt = letters.filter(l => l.status === 'fehlt');
  const entfaellt = letters.filter(l => l.status === 'entfaellt');

  const [strafaktePending, setStrafaktePending] = useState<string | null>(null);

  async function handleGenerate(typ: string, extras: Record<string, string> = {}) {
    if (!extractionId) return;
    if (typ.toLowerCase().includes('strafakte') && Object.keys(extras).length === 0) {
      setStrafaktePending(typ);
      return;
    }
    try {
      const response = await apiClient.post(
        `/generate-letter/${extractionId}/${encodeURIComponent(typ)}`,
        { extras },
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
      <div className="flex gap-2 mb-3.5">
        <StatsCardSmall label="Bereit" value={bereit.length} colorClass="text-ie-green" />
        <StatsCardSmall label="Daten fehlen" value={fehlt.length} colorClass="text-ie-amber" />
        <StatsCardSmall label="Entfällt" value={entfaellt.length} colorClass="text-ie-blue" />
      </div>

      <FieldChecklist
        title="Pflichtfelder für Anschreiben"
        fields={ANSCHREIBEN_REQUIRED_FIELDS}
        result={result}
        onUpdateField={onUpdateField}
      />

      {bereit.length > 0 && (
        <Section title="Alle Daten vorhanden" icon="✓" count={bereit.length}>
          {bereit.map((l, i) => <LetterCard key={i} letter={l} extractionId={extractionId} onGenerate={(t) => handleGenerate(t)} />)}
        </Section>
      )}
      {fehlt.length > 0 && (
        <Section title="Daten unvollständig" icon="△" count={fehlt.length}>
          {fehlt.map((l, i) => <LetterCard key={i} letter={l} extractionId={extractionId} onGenerate={(t) => handleGenerate(t)} />)}
        </Section>
      )}
      {entfaellt.length > 0 && (
        <Section title="Nicht erforderlich" icon="○" count={entfaellt.length} defaultOpen={false}>
          {entfaellt.map((l, i) => <LetterCard key={i} letter={l} extractionId={extractionId} onGenerate={(t) => handleGenerate(t)} />)}
        </Section>
      )}
      {letters.length === 0 && (
        <div className="text-center py-10 text-text-muted text-xs">
          Keine Anschreiben-Analyse verfügbar.
        </div>
      )}

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
                  <div className="text-[10px] text-ie-amber mt-0.5">→ Ermittlung über: {m.ermittlung_ueber}</div>
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
