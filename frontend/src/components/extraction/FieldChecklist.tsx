import { useState } from 'react';
import { usePdf } from '../../contexts/PdfContext';
import type { ExtractionResult, Pruefstatus, SourcedValue } from '../../types/extraction';

interface FieldChecklistProps {
  title: string;
  fields: { path: string; label: string }[];
  result: ExtractionResult;
  onUpdateField: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
  defaultOpen?: boolean;
}

function getField(result: ExtractionResult, path: string): SourcedValue | null {
  const parts = path.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return null;
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj && typeof obj === 'object' && ('wert' in (obj as object) || 'quelle' in (obj as object))) {
    return obj as SourcedValue;
  }
  return null;
}

function hasValue(field: SourcedValue | null): boolean {
  if (!field) return false;
  const w = field.wert;
  return w !== null && w !== undefined && String(w).trim() !== '';
}

function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function FieldRow({ path, label, result, onUpdate }: {
  path: string; label: string;
  result: ExtractionResult;
  onUpdate: (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => void;
}) {
  const field = getField(result, path);
  const filled = hasValue(field);
  const wert = filled ? String(field!.wert) : '';
  const quelle = field?.quelle || '';
  const pageNum = quelle ? parsePageNumber(quelle) : null;
  const pruefstatus = field?.pruefstatus;
  const { goToPageAndHighlight, totalPages } = usePdf();

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEdit = () => { setEditValue(wert); setEditing(true); };
  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed) onUpdate(path, trimmed, filled ? 'korrigiert' : 'manuell');
    setEditing(false);
  };

  const statusColor = pruefstatus === 'bestaetigt' ? 'text-ie-green'
    : (pruefstatus === 'korrigiert' || pruefstatus === 'manuell') ? 'text-ie-blue'
    : filled ? 'text-text-dim' : 'text-ie-red';

  const statusIcon = pruefstatus === 'bestaetigt' ? '\u2713'
    : pruefstatus === 'korrigiert' ? '\u270E'
    : pruefstatus === 'manuell' ? '+'
    : filled ? '\u25CB' : '\u2717';

  return (
    <div className="flex items-center py-1.5 border-b border-border/40 gap-2 group">
      <span className={`w-4 text-center text-[10px] font-bold ${statusColor}`}>{statusIcon}</span>
      <span className="flex-shrink-0 w-[140px] text-[10px] text-text-dim">{label}</span>
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            type="text"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(false); }}
            onBlur={saveEdit}
            autoFocus
            className="w-full bg-bg border border-accent rounded px-1.5 py-0.5 text-[10px] font-mono text-text outline-none"
          />
        ) : filled ? (
          <button
            onClick={startEdit}
            className="text-[10px] font-mono text-text hover:text-accent cursor-pointer bg-transparent border-none text-left truncate max-w-full"
            title={wert}
          >
            {wert.length > 40 ? wert.slice(0, 40) + '\u2026' : wert}
          </button>
        ) : (
          <button
            onClick={startEdit}
            className="text-[9px] text-ie-amber hover:text-accent cursor-pointer bg-transparent border-none"
          >
            Eintragen...
          </button>
        )}
      </div>
      {quelle && pageNum && totalPages > 0 && (
        <button
          onClick={() => goToPageAndHighlight(pageNum, filled ? wert : undefined, quelle)}
          className="bg-transparent border border-border rounded text-[7px] px-1 py-px cursor-pointer font-mono text-text-muted hover:border-accent hover:text-accent"
        >
          S.{pageNum}
        </button>
      )}
      {filled && !pruefstatus && (
        <button
          onClick={() => onUpdate(path, String(field!.wert), 'bestaetigt')}
          className="px-1.5 py-px border border-border rounded bg-transparent text-text-muted text-[9px] cursor-pointer font-mono hover:border-ie-green hover:text-ie-green opacity-0 group-hover:opacity-100 transition-opacity"
        >
          \u2713
        </button>
      )}
      {pruefstatus && (
        <span className={`text-[8px] px-1 py-px rounded font-mono border ${
          pruefstatus === 'bestaetigt' ? 'border-ie-green/30 text-ie-green' : 'border-ie-blue/30 text-ie-blue'
        }`}>
          {pruefstatus === 'bestaetigt' ? 'OK' : 'KORR.'}
        </span>
      )}
    </div>
  );
}

export function FieldChecklist({ title, fields, result, onUpdateField, defaultOpen = false }: FieldChecklistProps) {
  const [open, setOpen] = useState(defaultOpen);

  const filled = fields.filter(f => hasValue(getField(result, f.path))).length;
  const missing = fields.length - filled;

  return (
    <div className="bg-surface border border-border/60 rounded-lg shadow-card mb-2 overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-transparent border-none cursor-pointer hover:bg-bg/50 transition-colors"
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">{open ? '\u25BC' : '\u25B6'}</span>
          <span className="text-[11px] font-semibold text-text font-sans">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {missing > 0 ? (
            <span className="text-[9px] font-mono text-ie-amber">{missing} fehlend</span>
          ) : (
            <span className="text-[9px] font-mono text-ie-green">{filled}/{fields.length} komplett</span>
          )}
        </div>
      </button>
      {open && (
        <div className="px-3.5 pb-2.5 border-t border-border/40">
          {fields.map(f => (
            <FieldRow key={f.path} path={f.path} label={f.label} result={result} onUpdate={onUpdateField} />
          ))}
        </div>
      )}
    </div>
  );
}
