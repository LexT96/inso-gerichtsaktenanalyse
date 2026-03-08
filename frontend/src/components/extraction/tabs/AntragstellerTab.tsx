import { DataField } from '../DataField';
import { Section } from '../Section';
import type { Antragsteller } from '../../../types/extraction';

interface AntragstellerTabProps {
  antragsteller: Antragsteller;
}

export function AntragstellerTab({ antragsteller: a }: AntragstellerTabProps) {
  return (
    <Section title="Antragsteller" icon="◆">
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
  );
}
