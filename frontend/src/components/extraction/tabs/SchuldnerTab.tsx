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
          {s.fruehere_adressen.map((a, i) => {
            if (typeof a === 'string') {
              return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{a}</div>;
            }
            if (a && typeof a === 'object' && 'wert' in a) {
              return <DataField key={i} label={`Adresse ${i + 1}`} field={a} />;
            }
            if (a && typeof a === 'object' && 'adresse' in a) {
              const addr = a as { adresse?: string; einzug?: string; auszug?: string; zeitraum?: string; quelle?: string };
              const period = addr.zeitraum || (addr.einzug && addr.auszug ? `${addr.einzug} – ${addr.auszug}` : '');
              return (
                <DataField
                  key={i}
                  label={period || `Adresse ${i + 1}`}
                  field={{ wert: addr.adresse ?? '', quelle: addr.quelle ?? '' }}
                />
              );
            }
            return <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">{JSON.stringify(a)}</div>;
          })}
        </Section>
      )}
    </>
  );
}
