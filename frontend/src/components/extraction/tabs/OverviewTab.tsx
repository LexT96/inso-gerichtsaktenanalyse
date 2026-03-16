import { DataField } from '../DataField';
import { Section } from '../Section';
import { StatsBar } from '../StatsBar';
import { SourcedItem } from '../SourcedItem';
import type { ExtractionResult } from '../../../types/extraction';

interface OverviewTabProps {
  result: ExtractionResult;
  stats: { found: number; missing: number; total: number };
  lettersReady: number;
  lettersNA: number;
  lettersOpen: number;
}

export function OverviewTab({ result: r, stats, lettersReady, lettersNA, lettersOpen }: OverviewTabProps) {
  return (
    <>
      <StatsBar
        found={stats.found}
        missing={stats.missing}
        total={stats.total}
        lettersReady={lettersReady}
        lettersNA={lettersNA}
        lettersOpen={lettersOpen}
      />

      {r.zusammenfassung?.length > 0 && (
        <Section title="Zusammenfassung" icon="▤">
          {r.zusammenfassung.map((item, i) => (
            <SourcedItem key={i} item={item} />
          ))}
        </Section>
      )}

      <Section title="Verfahrensdaten" icon="⚖">
        <DataField label="Aktenzeichen" field={r.verfahrensdaten?.aktenzeichen} />
        <DataField label="Gericht" field={r.verfahrensdaten?.gericht} />
        <DataField label="Richter" field={r.verfahrensdaten?.richter} />
        <DataField label="Antragsdatum" field={r.verfahrensdaten?.antragsdatum} />
        <DataField label="Beschlussdatum" field={r.verfahrensdaten?.beschlussdatum} />
        <DataField label="Antragsart" field={r.verfahrensdaten?.antragsart} />
        <DataField label="Eröffnungsgrund" field={r.verfahrensdaten?.eroeffnungsgrund} />
        <DataField label="Zustellung Schuldner" field={r.verfahrensdaten?.zustellungsdatum_schuldner} />
      </Section>

      {r.fristen?.length > 0 && (
        <Section title="Fristen" icon="⏱" count={r.fristen.length}>
          {r.fristen.map((f, i) => (
            <div key={i} className="flex items-center py-1.5 border-b border-border gap-2.5">
              <span className="flex-1 text-[11px] text-text font-sans">{f.bezeichnung}</span>
              <span className="text-[11px] text-ie-amber font-semibold">{f.datum}</span>
              {f.quelle && <span className="text-[9px] text-text-muted">({f.quelle})</span>}
            </div>
          ))}
        </Section>
      )}

      {r.risiken_hinweise?.length > 0 && (
        <Section title="Risiken & Hinweise" icon="⚡" count={r.risiken_hinweise.length}>
          {r.risiken_hinweise.map((item, i) => (
            <SourcedItem key={i} item={item} variant="warning" />
          ))}
        </Section>
      )}
    </>
  );
}
