import { useState, useMemo } from 'react';
import { DataField } from '../DataField';
import { Section } from '../Section';
import { FieldChecklist } from '../FieldChecklist';
import { GutachtenDialog } from '../GutachtenDialog';
import type { ExtractionResult, Pruefstatus } from '../../../types/extraction';

interface GutachtenTabProps {
  result: ExtractionResult;
  extractionId: number | null;
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}

type TemplateType = 'juristische_person' | 'personengesellschaft' | 'natuerliche_person';

const JURISTISCHE_KEYWORDS = ['GmbH', 'UG', 'AG', 'SE', 'eG', 'gGmbH', 'KGaA', 'e.V.', 'Stiftung'];
const PERSONEN_KEYWORDS = ['OHG', 'KG', 'GbR', 'PartG'];

function detectTemplateType(rechtsform: string | null | undefined): TemplateType {
  if (!rechtsform) return 'natuerliche_person';
  const rf = rechtsform.trim();
  if (JURISTISCHE_KEYWORDS.some(k => rf.includes(k))) return 'juristische_person';
  if (PERSONEN_KEYWORDS.some(k => rf.includes(k))) return 'personengesellschaft';
  return 'natuerliche_person';
}

function templateLabel(type: TemplateType): string {
  switch (type) {
    case 'juristische_person': return 'juristische Person';
    case 'personengesellschaft': return 'Personengesellschaft';
    case 'natuerliche_person': return 'natürliche Person';
  }
}

// Fields that flow into the Gutachten template (KI_* placeholders)
const GUTACHTEN_FIELDS_BASE = [
  { path: 'verfahrensdaten.aktenzeichen', label: 'Aktenzeichen' },
  { path: 'verfahrensdaten.gericht', label: 'Gericht' },
  { path: 'verfahrensdaten.beschlussdatum', label: 'Beschlussdatum' },
  { path: 'verfahrensdaten.antragsdatum', label: 'Antragsdatum' },
  { path: 'verfahrensdaten.eroeffnungsgrund', label: 'Eröffnungsgrund' },
  { path: 'gutachterbestellung.gutachter_name', label: 'Gutachter' },
  { path: 'gutachterbestellung.gutachter_kanzlei', label: 'Kanzlei' },
  { path: 'gutachterbestellung.gutachter_adresse', label: 'Gutachter-Adresse' },
  { path: 'antragsteller.name', label: 'Antragsteller' },
  { path: 'antragsteller.adresse', label: 'Antragsteller-Adresse' },
];

const GUTACHTEN_FIELDS_PERSON = [
  { path: 'schuldner.name', label: 'Schuldner Name' },
  { path: 'schuldner.vorname', label: 'Schuldner Vorname' },
  { path: 'schuldner.geburtsdatum', label: 'Geburtsdatum' },
  { path: 'schuldner.aktuelle_adresse', label: 'Adresse' },
  { path: 'schuldner.familienstand', label: 'Familienstand' },
];

const GUTACHTEN_FIELDS_ENTITY = [
  { path: 'schuldner.firma', label: 'Firma' },
  { path: 'schuldner.rechtsform', label: 'Rechtsform' },
  { path: 'schuldner.handelsregisternummer', label: 'HRB' },
  { path: 'schuldner.betriebsstaette_adresse', label: 'Betriebsstätte' },
];

const GUTACHTEN_FIELDS_FINANCIAL = [
  { path: 'forderungen.gesamtforderungen', label: 'Gesamtforderungen' },
  { path: 'forderungen.gesicherte_forderungen', label: 'Gesicherte Forderungen' },
  { path: 'forderungen.ungesicherte_forderungen', label: 'Ungesicherte Forderungen' },
  { path: 'aktiva.summe_aktiva', label: 'Summe Aktiva' },
  { path: 'aktiva.massekosten_schaetzung', label: 'Massekosten' },
];

export function GutachtenTab({ result, extractionId, onUpdateField }: GutachtenTabProps) {
  const [showDialog, setShowDialog] = useState(false);

  const templateType = useMemo(
    () => detectTemplateType(result.schuldner?.rechtsform?.wert as string | null),
    [result.schuldner?.rechtsform?.wert],
  );

  const isJuristisch = templateType === 'juristische_person';
  const isNatuerlich = templateType === 'natuerliche_person';

  if (!extractionId) {
    return (
      <div className="text-center py-10 text-text-muted text-xs">
        Gutachten-Generierung nur für gespeicherte Extraktionen verfügbar.
      </div>
    );
  }

  return (
    <>
      {/* Template header */}
      <div className="bg-surface border border-border/60 rounded-lg shadow-card p-3 px-4 mb-3 flex items-center gap-3">
        <span className="text-sm">◇</span>
        <div>
          <div className="text-xs font-semibold text-text font-sans">
            Vorlage: Gutachten Muster {templateLabel(templateType)}
          </div>
          <div className="text-[10px] text-text-dim mt-0.5">
            Rechtsform: {(result.schuldner?.rechtsform?.wert as string) || '— (Standard: natürliche Person)'}
          </div>
        </div>
      </div>

      {/* Section 1: Aktenzeichen & Verfahren */}
      <Section title="Aktenzeichen & Verfahren" icon="▤">
        <DataField label="Aktenzeichen" field={result.verfahrensdaten?.aktenzeichen} />
        <DataField label="Gericht" field={result.verfahrensdaten?.gericht} />
        <DataField label="Beschlussdatum" field={result.verfahrensdaten?.beschlussdatum} />
        <DataField label="Antragsdatum" field={result.verfahrensdaten?.antragsdatum} />
      </Section>

      {/* Section 2: Schuldner */}
      <Section title="Schuldner" icon="◈">
        {isJuristisch || templateType === 'personengesellschaft' ? (
          <>
            <DataField label="Firma" field={result.schuldner?.firma} />
            <DataField label="Rechtsform" field={result.schuldner?.rechtsform} />
            <DataField label="Betriebsstätte" field={result.schuldner?.betriebsstaette_adresse} />
          </>
        ) : (
          <>
            <DataField label="Name" field={result.schuldner?.name} />
            <DataField label="Vorname" field={result.schuldner?.vorname} />
            <DataField label="Geschlecht" field={result.schuldner?.geschlecht} />
            <DataField label="Adresse" field={result.schuldner?.aktuelle_adresse} />
          </>
        )}
      </Section>

      {/* Section 3: Gutachter/Verwalter */}
      <Section title="Gutachter / Verwalter (aus Akte)" icon="◊">
        <DataField label="Gutachter" field={result.gutachterbestellung?.gutachter_name} />
        <DataField label="Adresse" field={result.gutachterbestellung?.gutachter_adresse} />
        <DataField label="Kanzlei" field={result.gutachterbestellung?.gutachter_kanzlei} />
      </Section>

      {/* Section 4: Fehlende Angaben */}
      <Section title="Fehlende Angaben (vom Nutzer einzugeben)" icon="△">
        <div className="space-y-1.5 py-1">
          <UserInputRow label="Diktatzeichen des Verwalters" required />
          <UserInputRow label="Geschlecht des Verwalters" required hint="männlich / weiblich" />
          <UserInputRow label="Anderkonto IBAN" />
          <UserInputRow label="Anderkonto Bank" />
          {isJuristisch && (
            <UserInputRow label="Geschäftsführer" hint="nur bei juristischer Person" />
          )}
          {isNatuerlich && (
            <UserInputRow label="Last GAVV" hint="nur bei natürlicher Person" />
          )}
        </div>
      </Section>

      {/* Pflichtfelder-Checkliste */}
      <FieldChecklist
        title="Verfahren & Beteiligte"
        fields={[...GUTACHTEN_FIELDS_BASE, ...(isNatuerlich ? GUTACHTEN_FIELDS_PERSON : GUTACHTEN_FIELDS_ENTITY)]}
        result={result}
        onUpdateField={onUpdateField}
      />
      <FieldChecklist
        title="Finanzdaten (für Verfahrenskostendeckung)"
        fields={GUTACHTEN_FIELDS_FINANCIAL}
        result={result}
        onUpdateField={onUpdateField}
      />

      {/* Generate button */}
      <div className="mt-4 flex justify-center">
        <button
          onClick={() => setShowDialog(true)}
          className="px-6 py-2.5 bg-accent text-white rounded-md text-[11px] font-mono font-semibold hover:bg-accent/90 transition-all tracking-wide active:scale-[0.98]"
        >
          GUTACHTEN GENERIEREN
        </button>
      </div>

      {/* Dialog */}
      {showDialog && (
        <GutachtenDialog
          result={result}
          extractionId={extractionId}
          onClose={() => setShowDialog(false)}
        />
      )}
    </>
  );
}

function UserInputRow({ label, required, hint }: { label: string; required?: boolean; hint?: string }) {
  return (
    <div className="flex items-center py-1.5 border-b border-border gap-2">
      <span className="flex-shrink-0 w-[180px] text-[11px] text-text-dim pt-0.5 flex items-center gap-1.5">
        {required && <span className="text-red-400 text-[9px]">●</span>}
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-[10px] text-text-muted italic">
          {required ? 'Pflichtangabe — wird im Dialog abgefragt' : 'Optional — wird im Dialog abgefragt'}
        </span>
        {hint && (
          <span className="text-[9px] text-text-dim ml-2">({hint})</span>
        )}
      </div>
    </div>
  );
}
