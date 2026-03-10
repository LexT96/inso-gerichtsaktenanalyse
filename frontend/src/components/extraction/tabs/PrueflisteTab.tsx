import { useState } from 'react';
import { Section } from '../Section';
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

const SCHULDNER_PERSON_FIELDS: FieldDef[] = [
  { path: 'schuldner.name', label: 'Name' },
  { path: 'schuldner.vorname', label: 'Vorname' },
  { path: 'schuldner.geburtsdatum', label: 'Geburtsdatum' },
  { path: 'schuldner.aktuelle_adresse', label: 'Aktuelle Adresse' },
  { path: 'schuldner.handelsregisternummer', label: 'Handelsregister-Nr.' },
];

const SCHULDNER_FIRMA_FIELDS: FieldDef[] = [
  { path: 'schuldner.firma', label: 'Firma' },
  { path: 'schuldner.betriebsstaette_adresse', label: 'Betriebsst\u00e4tte-Adresse' },
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

interface CheckFieldRowProps {
  def: FieldDef;
  result: ExtractionResult;
  onUpdate: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}

function CheckFieldRow({ def, result, onUpdate }: CheckFieldRowProps) {
  const field = getField(result, def.path);
  const hasVal = fieldHasValue(field);
  const wert = hasVal ? String(field!.wert) : '';
  const pruefstatus = field?.pruefstatus;

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

  const statusIcon = pruefstatus === 'bestaetigt' ? '\u2713'
    : pruefstatus === 'korrigiert' ? '\u270e'
    : pruefstatus === 'manuell' ? '+'
    : null;

  const statusColor = pruefstatus === 'bestaetigt' ? 'text-ie-green'
    : (pruefstatus === 'korrigiert' || pruefstatus === 'manuell') ? 'text-ie-blue'
    : 'text-text-muted';

  return (
    <div className="flex items-center py-2 border-b border-border gap-2">
      {/* Status icon */}
      <span className={`w-5 text-center text-xs font-bold ${statusColor}`}>
        {statusIcon ?? '\u25cb'}
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

      {/* Confirm button */}
      {hasVal && !pruefstatus && (
        <button
          onClick={handleConfirm}
          title="Wert best\u00e4tigen"
          className="px-2 py-0.5 border border-border rounded-sm bg-transparent text-text-muted text-[10px] cursor-pointer font-mono hover:border-ie-green hover:text-ie-green transition-colors"
        >
          {'\u2713'}
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

export function PrueflisteTab({ result, onUpdateField }: PrueflisteTabProps) {
  const allFields = [VERFAHRENSDATEN_FIELDS, SCHULDNER_PERSON_FIELDS, SCHULDNER_FIRMA_FIELDS];
  const { confirmed, total } = countStats(result, allFields);
  const percent = total > 0 ? Math.round((confirmed / total) * 100) : 0;

  return (
    <>
      {/* Progress bar */}
      <div className="bg-surface border border-border rounded-sm mb-2.5 p-3 px-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-text font-sans">Pr\u00fcffortschritt</span>
          <span className="text-[11px] font-mono text-text-dim">
            {confirmed} von {total} gepr\u00fcft
          </span>
        </div>
        <div className="w-full h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-ie-green rounded-full transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <Section title="Verfahrensdaten" icon={'\u25ce'} count={VERFAHRENSDATEN_FIELDS.length}>
        {VERFAHRENSDATEN_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <Section title="Schuldner \u2014 Person" icon={'\u25cf'} count={SCHULDNER_PERSON_FIELDS.length}>
        {SCHULDNER_PERSON_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <Section title="Schuldner \u2014 Firma" icon={'\u25a1'} count={SCHULDNER_FIRMA_FIELDS.length}>
        {SCHULDNER_FIRMA_FIELDS.map(def => (
          <CheckFieldRow key={def.path} def={def} result={result} onUpdate={onUpdateField} />
        ))}
      </Section>

      <div className="mt-2 p-2 px-4 text-[9px] text-text-muted">
        Diese Felder werden f\u00fcr die Erstellung der Standardanschreiben ben\u00f6tigt.
        Best\u00e4tigte und korrigierte Werte flie\u00dfen direkt in die Briefgenerierung ein.
      </div>
    </>
  );
}
