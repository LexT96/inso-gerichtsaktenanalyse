import { DataField } from '../DataField';
import { Section } from '../Section';
import type { Schuldner } from '../../../types/extraction';

interface SchuldnerTabProps {
  schuldner: Schuldner;
}

export function SchuldnerTab({ schuldner: s }: SchuldnerTabProps) {
  return (
    <>
      <Section title="Persönliche Daten" icon="●">
        <DataField label="Name" field={s?.name} />
        <DataField label="Vorname" field={s?.vorname} />
        <DataField label="Geburtsdatum" field={s?.geburtsdatum} />
        <DataField label="Geburtsort" field={s?.geburtsort} />
        <DataField label="Geburtsland" field={s?.geburtsland} />
        <DataField label="Staatsangehörigkeit" field={s?.staatsangehoerigkeit} />
        <DataField label="Familienstand" field={s?.familienstand} />
        <DataField label="Geschlecht" field={s?.geschlecht} />
      </Section>
      <Section title="Adresse & Betrieb" icon="◻">
        <DataField label="Aktuelle Adresse" field={s?.aktuelle_adresse} />
        <DataField label="Firma" field={s?.firma} />
        <DataField label="Rechtsform" field={s?.rechtsform} />
        <DataField label="Betriebsstätte" field={s?.betriebsstaette_adresse} />
        <DataField label="Handelsregister-Nr." field={s?.handelsregisternummer} />
      </Section>
      {s?.fruehere_adressen?.length > 0 && (
        <Section title="Frühere Adressen" icon="◌" count={s.fruehere_adressen.length} defaultOpen={false}>
          {s.fruehere_adressen.map((a, i) => (
            <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">
              {typeof a === 'string' ? a : (a && typeof a === 'object' && 'wert' in a ? String(a.wert) : JSON.stringify(a))}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
