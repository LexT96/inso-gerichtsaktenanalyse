import { DataField } from '../DataField';
import { Section } from '../Section';
import type { Ermittlungsergebnisse, Gutachterbestellung } from '../../../types/extraction';

interface ErmittlungTabProps {
  ermittlungsergebnisse: Ermittlungsergebnisse;
  gutachterbestellung: Gutachterbestellung;
}

export function ErmittlungTab({ ermittlungsergebnisse: e, gutachterbestellung: g }: ErmittlungTabProps) {
  return (
    <>
      <Section title="Grundbuch" icon="▤">
        <DataField label="Ergebnis" field={e?.grundbuch?.ergebnis} />
        <DataField label="Grundbesitz vorhanden" field={e?.grundbuch?.grundbesitz_vorhanden} />
        <DataField label="Datum" field={e?.grundbuch?.datum} />
      </Section>
      <Section title="Gerichtsvollzieher" icon="◈">
        <DataField label="Name" field={e?.gerichtsvollzieher?.name} />
        <DataField label="Betriebsstätte bekannt" field={e?.gerichtsvollzieher?.betriebsstaette_bekannt} />
        <DataField label="Vollstreckungen" field={e?.gerichtsvollzieher?.vollstreckungen} />
        <DataField label="Masse deckend" field={e?.gerichtsvollzieher?.masse_deckend} />
        <DataField label="Vermögensauskunft" field={e?.gerichtsvollzieher?.vermoegensauskunft_abgegeben} />
        <DataField label="Haftbefehle" field={e?.gerichtsvollzieher?.haftbefehle} />
        <DataField label="Datum" field={e?.gerichtsvollzieher?.datum} />
      </Section>
      <Section title="Vollstreckungsportal" icon="◉">
        <DataField label="Schuldnerverzeichnis" field={e?.vollstreckungsportal?.schuldnerverzeichnis_eintrag} />
        <DataField label="Vermögensverzeichnis" field={e?.vollstreckungsportal?.vermoegensverzeichnis_eintrag} />
      </Section>
      <Section title="Meldeauskunft" icon="◎">
        <DataField label="Meldestatus" field={e?.meldeauskunft?.meldestatus} />
        <DataField label="Datum" field={e?.meldeauskunft?.datum} />
      </Section>
      <Section title="Gutachterbestellung" icon="◊">
        <DataField label="Gutachter" field={g?.gutachter_name} />
        <DataField label="Kanzlei" field={g?.gutachter_kanzlei} />
        <DataField label="Adresse" field={g?.gutachter_adresse} />
        <DataField label="Telefon" field={g?.gutachter_telefon} />
        <DataField label="E-Mail" field={g?.gutachter_email} />
        <DataField label="Abgabefrist" field={g?.abgabefrist} />
      </Section>
    </>
  );
}
