import { DataField } from '../DataField';
import { Section } from '../Section';
import type { Schuldner, Antragsteller } from '../../../types/extraction';

interface BeteiligteTabProps {
  schuldner: Schuldner;
  antragsteller: Antragsteller;
}

export function BeteiligteTab({ schuldner: s, antragsteller: a }: BeteiligteTabProps) {
  return (
    <>
      <Section title="Schuldner — Persönliche Daten" icon={'\u25cf'}>
        <DataField label="Name" field={s?.name} />
        <DataField label="Vorname" field={s?.vorname} />
        <DataField label="Geburtsdatum" field={s?.geburtsdatum} />
        <DataField label="Geburtsort" field={s?.geburtsort} />
        <DataField label="Geburtsland" field={s?.geburtsland} />
        <DataField label="Staatsangehörigkeit" field={s?.staatsangehoerigkeit} />
        <DataField label="Familienstand" field={s?.familienstand} />
        <DataField label="Geschlecht" field={s?.geschlecht} />
      </Section>
      <Section title="Schuldner — Adresse & Betrieb" icon={'\u25fb'}>
        <DataField label="Aktuelle Adresse" field={s?.aktuelle_adresse} />
        <DataField label="Firma" field={s?.firma} />
        <DataField label="Rechtsform" field={s?.rechtsform} />
        <DataField label="Betriebsstätte" field={s?.betriebsstaette_adresse} />
        <DataField label="Handelsregister-Nr." field={s?.handelsregisternummer} />
      </Section>
      {s?.fruehere_adressen?.length > 0 && (
        <Section title="Schuldner — Frühere Adressen" icon={'\u25cc'} count={s.fruehere_adressen.length} defaultOpen={false}>
          {s.fruehere_adressen.map((addr, i) => {
            if (typeof addr === 'object' && addr && 'wert' in addr) {
              return <DataField key={i} label={`Adresse ${i + 1}`} field={addr} />;
            }
            return (
              <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">
                {typeof addr === 'string' ? addr : JSON.stringify(addr)}
              </div>
            );
          })}
        </Section>
      )}
      {s?.kinder?.length > 0 && (
        <Section title="Schuldner — Kinder" icon={'\u25cb'} count={s.kinder.length} defaultOpen={false}>
          {s.kinder.map((kind, i) => {
            if (typeof kind === 'object' && kind && 'wert' in kind) {
              return <DataField key={i} label={`Kind ${i + 1}`} field={kind} />;
            }
            return (
              <div key={i} className="py-1.5 border-b border-border text-[11px] text-text-dim">
                {typeof kind === 'string' ? kind : JSON.stringify(kind)}
              </div>
            );
          })}
        </Section>
      )}
      <Section title="Antragsteller" icon={'\u25c6'}>
        <DataField label="Name" field={a?.name} />
        <DataField label="Adresse" field={a?.adresse} />
        <DataField label="Ansprechpartner" field={a?.ansprechpartner} />
        <DataField label="Telefon" field={a?.telefon} />
        <DataField label="Fax" field={a?.fax} />
        <DataField label="E-Mail" field={a?.email} />
        <DataField label="Betriebsnummer" field={a?.betriebsnummer} />
        <DataField label="IBAN" field={a?.bankverbindung_iban} />
        <DataField label="BIC" field={a?.bankverbindung_bic} />
      </Section>
    </>
  );
}
