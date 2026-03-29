import { useState } from 'react';
import { Section } from '../Section';
import { usePdf } from '../../../contexts/PdfContext';
import type { ExtractionResult, SourcedValue, Pruefstatus } from '../../../types/extraction';

interface PrueflisteTabProps {
  result: ExtractionResult;
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}

interface FieldDef {
  path: string;
  label: string;
}

const VERFAHRENSDATEN_FIELDS: FieldDef[] = [
  { path: 'verfahrensdaten.aktenzeichen', label: 'Aktenzeichen' },
  { path: 'verfahrensdaten.gericht', label: 'Gericht' },
];

// Natürliche Person: persönliche Daten
const SCHULDNER_PERSON_FIELDS: FieldDef[] = [
  { path: 'schuldner.name', label: 'Name' },
  { path: 'schuldner.vorname', label: 'Vorname' },
  { path: 'schuldner.geburtsdatum', label: 'Geburtsdatum' },
  { path: 'schuldner.aktuelle_adresse', label: 'Aktuelle Adresse' },
];

// Juristische Person / Gesellschaft: Firmendaten
const SCHULDNER_ENTITY_FIELDS: FieldDef[] = [
  { path: 'schuldner.firma', label: 'Firma' },
  { path: 'schuldner.rechtsform', label: 'Rechtsform' },
  { path: 'schuldner.handelsregisternummer', label: 'Handelsregister-Nr.' },
  { path: 'schuldner.betriebsstaette_adresse', label: 'Betriebsstätte-Adresse' },
];

// Shared (nur bei natürlicher Person mit Gewerbebetrieb)
const SCHULDNER_FIRMA_FIELDS: FieldDef[] = [
  { path: 'schuldner.firma', label: 'Firma' },
  { path: 'schuldner.betriebsstaette_adresse', label: 'Betriebsstätte-Adresse' },
];

const FORDERUNGEN_FIELDS: FieldDef[] = [
  { path: 'forderungen.gesamtforderungen', label: 'Gesamtforderungen' },
  { path: 'forderungen.gesicherte_forderungen', label: 'Gesicherte Forderungen' },
  { path: 'forderungen.ungesicherte_forderungen', label: 'Ungesicherte Forderungen' },
];

const AKTIVA_FIELDS: FieldDef[] = [
  { path: 'aktiva.summe_aktiva', label: 'Summe Aktiva' },
  { path: 'aktiva.massekosten_schaetzung', label: 'Massekosten (Schätzung)' },
];

const BESCHAEFTIGUNG_FIELDS: FieldDef[] = [
  { path: 'schuldner.beschaeftigung.nettoeinkommen', label: 'Nettoeinkommen' },
  { path: 'schuldner.pfaendungsberechnung.pfaendbarer_betrag', label: 'Pfändbarer Betrag' },
];

function getField(result: ExtractionResult, path: string): SourcedValue | null {
  const parts = path.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj && typeof obj === 'object' && 'quelle' in (obj as object)) {
    return obj as SourcedValue;
  }
  return null;
}

function fieldHasValue(field: SourcedValue | null): boolean {
  if (!field) return false;
  const w = field.wert;
  return w !== null && w !== undefined && String(w).trim() !== '';
}

function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

interface CheckFieldRowProps {
  def: FieldDef;
  result: ExtractionResult;
  onUpdate: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}

function CheckFieldRow({ def, result, onUpdate }: CheckFieldRowProps) {
  const field = getField(result, def.path);
  const hasVal = fieldHasValue(field);
  const wert = hasVal ? String(field!.wert) : '';
  const quelle = field?.quelle || '';
  const pageNum = quelle ? parsePageNumber(quelle) : null;
  const verifiziert = field?.verifiziert;
  const pruefstatus = field?.pruefstatus;

  const { goToPageAndHighlight, totalPages } = usePdf();

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEdit = () => {
    setEditValue(wert);
    setEditing(true);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed === '') {
      setEditing(false);
      return;
    }
    const status: Pruefstatus = hasVal ? 'korrigiert' : 'manuell';
    onUpdate(def.path, trimmed, status);
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const handleConfirm = () => {
    if (hasVal) {
      onUpdate(def.path, String(field!.wert), 'bestaetigt');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  const handleRefClick = () => {
    if (pageNum && totalPages > 0) {
      const searchText = hasVal ? wert : undefined;
      goToPageAndHighlight(pageNum, searchText, quelle);
    }
  };

  const statusIcon = pruefstatus === 'bestaetigt' ? '✓'
    : pruefstatus === 'korrigiert' ? '✎'
    : pruefstatus === 'manuell' ? '+'
    : null;

  const statusColor = pruefstatus === 'bestaetigt' ? 'text-ie-green'
    : (pruefstatus === 'korrigiert' || pruefstatus === 'manuell') ? 'text-ie-blue'
    : 'text-text-muted';

  const isUnverified = verifiziert === false;

  return (
    <div className="flex items-center py-2 border-b border-border gap-2">
      {/* Status icon */}
      <span className={`w-5 text-center text-xs font-bold ${statusColor}`}>
        {statusIcon ?? '○'}
      </span>

      {/* Label */}
      <span className="flex-shrink-0 w-[160px] text-[11px] text-text-dim">{def.label}</span>

      {/* Value */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={saveEdit}
            autoFocus
            className="w-full bg-bg border border-accent rounded-sm px-2 py-1 text-xs font-mono text-text outline-none"
          />
        ) : hasVal ? (
          <button
            onClick={startEdit}
            className="text-xs font-mono text-text hover:text-accent cursor-pointer bg-transparent border-none text-left transition-colors"
            title="Klicken zum Bearbeiten"
          >
            {wert}
          </button>
        ) : (
          <button
            onClick={startEdit}
            className="text-[10px] text-ie-amber hover:text-accent cursor-pointer bg-transparent border-none transition-colors"
          >
            Eintragen...
          </button>
        )}
      </div>

      {/* Source reference button */}
      {quelle && (
        <button
          onClick={handleRefClick}
          title={isUnverified ? 'Quelle nicht verifiziert' : pageNum ? `Seite ${pageNum} anzeigen` : 'Quelle anzeigen'}
          className={`bg-transparent border rounded-sm text-[8px] px-1.5 py-px cursor-pointer font-mono tracking-wide transition-colors
            ${isUnverified
              ? 'border-ie-amber-border text-ie-amber'
              : pageNum
                ? 'border-ie-blue-border text-ie-blue hover:border-ie-blue hover:text-ie-blue'
                : 'border-border text-text-muted hover:border-accent hover:text-accent'
            }`}
        >
          {isUnverified ? '?' : pageNum ? `S.${pageNum}` : 'Q'}
        </button>
      )}

      {/* Confirm button */}
      {hasVal && !pruefstatus && (
        <button
          onClick={handleConfirm}
          title="Wert bestätigen"
          className="px-2 py-0.5 border border-border rounded-sm bg-transparent text-text-muted text-[10px] cursor-pointer font-mono hover:border-ie-green hover:text-ie-green transition-colors"
        >
          ✓
        </button>
      )}

      {/* Already confirmed indicator */}
      {pruefstatus && (
        <span className={`text-[9px] px-1.5 py-px rounded-sm font-mono border ${
          pruefstatus === 'bestaetigt' ? 'border-ie-green/30 text-ie-green bg-ie-green/5'
          : 'border-ie-blue/30 text-ie-blue bg-ie-blue/5'
        }`}>
          {pruefstatus === 'bestaetigt' ? 'OK' : pruefstatus === 'korrigiert' ? 'KORR.' : 'MANUELL'}
        </span>
      )}
    </div>
  );
}

function countStats(result: ExtractionResult, fields: FieldDef[][]): { confirmed: number; total: number } {
  let confirmed = 0;
  let total = 0;
  for (const group of fields) {
    for (const def of group) {
      total++;
      const field = getField(result, def.path);
      if (field?.pruefstatus) confirmed++;
    }
  }
  return { confirmed, total };
}

function isEntitySchuldner(result: ExtractionResult): boolean {
  const rf = String(result.schuldner?.rechtsform?.wert ?? '').toLowerCase();
  if (!rf) return false;
  return /gmbh|ug\b|ag\b|se\b|kg\b|ohg|gbr|e\.?\s?v|partg|stiftung|verein|genossenschaft|kgaa/i.test(rf)
    || rf.includes('juristische') || rf.includes('gesellschaft');
}

export function PrueflisteTab({ result, onUpdateField }: PrueflisteTabProps) {
  const isEntity = isEntitySchuldner(result);

  // Entity-aware field selection
  const schuldnerFields = isEntity ? SCHULDNER_ENTITY_FIELDS : SCHULDNER_PERSON_FIELDS;
  const allFields = [
    VERFAHRENSDATEN_FIELDS,
    schuldnerFields,
    FORDERUNGEN_FIELDS,
    AKTIVA_FIELDS,
    ...(isEntity ? [] : [BESCHAEFTIGUNG_FIELDS]),
  ];
  const { confirmed, total } = countStats(result, allFields);
  const percent = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  return (
    <>
      {/* Progress bar */}
      <div className="bg-surface border border-border rounded-sm mb-2.5 p-3 px-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-text font-sans">Prüffortschritt</span>
          <span className="text-[11px] font-mono text-text-dim">
            {confirmed} von {total} geprüft
          </span>
        </div>
        <div className="w-full h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-ie-green rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <Section title="Verfahrensdaten" icon="◎" count={VERFAHRENSDATEN_FIELDS.length}>
        {VERFAHRENSDATEN_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      {isEntity ? (
        <Section title="Schuldner — Unternehmen" icon="●" count={SCHULDNER_ENTITY_FIELDS.length}>
          {SCHULDNER_ENTITY_FIELDS.map(def => (
            <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
          ))}
        </Section>
      ) : (
        <>
          <Section title="Schuldner — Person" icon="●" count={SCHULDNER_PERSON_FIELDS.length}>
            {SCHULDNER_PERSON_FIELDS.map(def => (
              <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
            ))}
          </Section>
          {(result.schuldner?.firma?.wert || result.schuldner?.betriebsstaette_adresse?.wert) && (
            <Section title="Schuldner — Firma" icon="□" count={SCHULDNER_FIRMA_FIELDS.length}>
              {SCHULDNER_FIRMA_FIELDS.map(def => (
                <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
              ))}
            </Section>
          )}
        </>
      )}

      <Section title="Forderungen (EUR-Beträge)" icon="€" count={FORDERUNGEN_FIELDS.length}>
        {FORDERUNGEN_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <Section title="Vermögenswerte (EUR-Beträge)" icon="▣" count={AKTIVA_FIELDS.length}>
        {AKTIVA_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      {!isEntity && (
        <Section title="Einkommen & Pfändung" icon="●" count={BESCHAEFTIGUNG_FIELDS.length}>
          {BESCHAEFTIGUNG_FIELDS.map(def => (
            <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
          ))}
        </Section>
      )}

      <div className="mt-2 p-2 px-4 text-[9px] text-text-muted">
        Alle Beträge sollten vor Verwendung in Gutachten und Berechnungen manuell verifiziert werden.
        Bestätigte und korrigierte Werte fließen direkt in die Briefgenerierung ein.
      </div>
    </>
  );
}
