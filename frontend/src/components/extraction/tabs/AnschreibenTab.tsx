import { useState } from 'react';
import { Badge } from '../Badge';
import { Section } from '../Section';
import type { Standardanschreiben } from '../../../types/extraction';

function LetterCard({ letter }: { letter: Standardanschreiben }) {
  const [expanded, setExpanded] = useState(false);
  const st = letter.status || 'fehlt';

  const bgClass = st === 'bereit' ? 'bg-ie-green-bg border-ie-green-border'
    : st === 'entfaellt' ? 'bg-ie-blue-bg border-ie-blue-border'
    : 'bg-ie-amber-bg border-ie-amber-border';

  return (
    <div
      className={`border rounded-sm p-2.5 px-3.5 mb-1.5 cursor-pointer ${bgClass}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex justify-between items-center">
        <div>
          <div className="text-xs font-semibold text-text font-sans">{letter.typ}</div>
          <div className="text-[10px] text-text-dim mt-0.5">An: {letter.empfaenger}</div>
        </div>
        <Badge type={st} />
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
    <div className="bg-surface border border-border rounded-sm py-3.5 px-4 text-center flex-1">
      <div className={`text-2xl font-bold font-mono ${colorClass}`}>{value}</div>
      <div className="text-[9px] text-text-muted mt-0.5 uppercase tracking-wide">{label}</div>
    </div>
  );
}

interface AnschreibenTabProps {
  letters: Standardanschreiben[];
}

export function AnschreibenTab({ letters }: AnschreibenTabProps) {
  const bereit = letters.filter(l => l.status === 'bereit');
  const fehlt = letters.filter(l => l.status === 'fehlt');
  const entfaellt = letters.filter(l => l.status === 'entfaellt');

  return (
    <>
      <div className="flex gap-2 mb-3.5">
        <StatsCardSmall label="Bereit" value={bereit.length} colorClass="text-ie-green" />
        <StatsCardSmall label="Daten fehlen" value={fehlt.length} colorClass="text-ie-amber" />
        <StatsCardSmall label="Entfällt" value={entfaellt.length} colorClass="text-ie-blue" />
      </div>

      {bereit.length > 0 && (
        <Section title="Sofort generierbar" icon="✓" count={bereit.length}>
          {bereit.map((l, i) => <LetterCard key={i} letter={l} />)}
        </Section>
      )}
      {fehlt.length > 0 && (
        <Section title="Daten unvollständig" icon="△" count={fehlt.length}>
          {fehlt.map((l, i) => <LetterCard key={i} letter={l} />)}
        </Section>
      )}
      {entfaellt.length > 0 && (
        <Section title="Bereits erledigt" icon="○" count={entfaellt.length}>
          {entfaellt.map((l, i) => <LetterCard key={i} letter={l} />)}
        </Section>
      )}
      {letters.length === 0 && (
        <div className="text-center py-10 text-text-muted text-xs">
          Keine Anschreiben-Analyse verfügbar.
        </div>
      )}
    </>
  );
}
