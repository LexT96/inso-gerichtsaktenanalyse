import { DataField } from '../DataField';
import { Section } from '../Section';
import type { Forderungen } from '../../../types/extraction';

function getNumberValue(field: { wert: number | null } | null | undefined): number | null {
  if (!field) return null;
  return field.wert;
}

interface ForderungenTabProps {
  forderungen: Forderungen;
}

export function ForderungenTab({ forderungen: f }: ForderungenTabProps) {
  const gesamtVal = getNumberValue(f?.gesamtforderung);

  return (
    <>
      <Section title="Forderungsaufstellung" icon="€">
        <DataField label="SV-Beiträge" field={f?.hauptforderung_beitraege} isCurrency />
        <DataField label="Säumniszuschläge" field={f?.saeumniszuschlaege} isCurrency />
        <DataField label="Mahngebühren" field={f?.mahngebuehren} isCurrency />
        <DataField label="Vollstreckungskosten" field={f?.vollstreckungskosten} isCurrency />
        <DataField label="Antragskosten" field={f?.antragskosten} isCurrency />
        <div className="flex justify-between py-2.5 border-t-2 border-accent mt-1.5">
          <span className="text-xs font-bold text-text">Gesamtforderung</span>
          <span className="text-sm font-bold text-ie-red">
            {gesamtVal !== null && gesamtVal !== undefined
              ? `${gesamtVal.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`
              : '—'}
          </span>
        </div>
      </Section>
      <Section title="Zeitraum & laufende Kosten" icon="◷">
        <DataField label="Zeitraum von" field={f?.zeitraum_von} />
        <DataField label="Zeitraum bis" field={f?.zeitraum_bis} />
        <DataField label="Laufende mtl. Beiträge" field={f?.laufende_monatliche_beitraege} isCurrency />
      </Section>
      {f?.betroffene_arbeitnehmer?.length > 0 && (
        <Section title="Betroffene Arbeitnehmer" icon="▣" count={f.betroffene_arbeitnehmer.length} defaultOpen={false}>
          {f.betroffene_arbeitnehmer.map((a, i) => (
            <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">
              {typeof a === 'string' ? a : (a && typeof a === 'object' ? ('wert' in a ? String(a.wert) : ('name' in a ? String(a.name) : JSON.stringify(a))) : String(a))}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
