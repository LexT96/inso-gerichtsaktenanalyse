import { useState } from 'react';
import type { MergeDiff, MergeFieldChange } from '../../types/extraction';

interface MergeSummaryProps {
  diff: MergeDiff;
  onApply: (acceptedPaths: string[], changes: Array<{ path: string; wert: unknown; quelle: string }>) => void;
  onCancel: () => void;
  applying: boolean;
}

function FieldRow({ change, checked, onToggle, variant }: {
  change: MergeFieldChange;
  checked: boolean;
  onToggle: () => void;
  variant: 'new' | 'updated' | 'conflict';
}) {
  const colors = {
    new: 'border-green-800/40 bg-green-900/10',
    updated: 'border-blue-800/40 bg-blue-900/10',
    conflict: 'border-red-800/40 bg-red-900/10',
  };

  return (
    <label className={`flex items-start gap-2 p-2 rounded border ${colors[variant]} cursor-pointer`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 accent-accent" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-text-dim font-mono">{change.path}</div>
        {change.oldWert !== undefined && (
          <div className="text-[11px] text-red-400 line-through truncate">{String(change.oldWert)}</div>
        )}
        <div className="text-[11px] text-text truncate">{String(change.wert)}</div>
        <div className="text-[9px] text-text-muted mt-0.5">{change.quelle}</div>
        {change.reason && <div className="text-[9px] text-text-dim italic mt-0.5">{change.reason}</div>}
      </div>
    </label>
  );
}

export function MergeSummary({ diff, onApply, onCancel, applying }: MergeSummaryProps) {
  const allChanges = [...diff.newFields, ...diff.updatedFields, ...diff.conflicts];
  const [accepted, setAccepted] = useState<Set<string>>(() => {
    // Default: accept new + updated, conflicts unchecked
    const set = new Set<string>();
    for (const f of diff.newFields) set.add(f.path);
    for (const f of diff.updatedFields) set.add(f.path);
    return set;
  });

  const toggle = (path: string) => {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleApply = () => {
    const paths = [...accepted];
    const changes = allChanges
      .filter(c => accepted.has(c.path))
      .map(c => ({ path: c.path, wert: c.wert, quelle: c.quelle }));
    onApply(paths, changes);
  };

  const totalChanges = allChanges.length + diff.newForderungen.length + diff.updatedForderungen.length;

  if (totalChanges === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-[11px] text-text-muted">Keine neuen Daten gefunden -- das Dokument enthält keine zusätzlichen Informationen.</p>
        <button onClick={onCancel} className="mt-4 px-4 py-1.5 text-[11px] text-text-muted hover:text-text">
          Schliessen
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {diff.newFields.length > 0 && (
        <div>
          <h4 className="text-[10px] text-green-400 font-semibold mb-1.5">{diff.newFields.length} neue Felder</h4>
          <div className="space-y-1">
            {diff.newFields.map(f => (
              <FieldRow key={f.path} change={f} checked={accepted.has(f.path)} onToggle={() => toggle(f.path)} variant="new" />
            ))}
          </div>
        </div>
      )}

      {diff.updatedFields.length > 0 && (
        <div>
          <h4 className="text-[10px] text-blue-400 font-semibold mb-1.5">{diff.updatedFields.length} aktualisierte Felder</h4>
          <div className="space-y-1">
            {diff.updatedFields.map(f => (
              <FieldRow key={f.path} change={f} checked={accepted.has(f.path)} onToggle={() => toggle(f.path)} variant="updated" />
            ))}
          </div>
        </div>
      )}

      {diff.conflicts.length > 0 && (
        <div>
          <h4 className="text-[10px] text-red-400 font-semibold mb-1.5">{diff.conflicts.length} Konflikte -- bitte entscheiden</h4>
          <div className="space-y-1">
            {diff.conflicts.map(f => (
              <FieldRow key={f.path} change={f} checked={accepted.has(f.path)} onToggle={() => toggle(f.path)} variant="conflict" />
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={handleApply}
          disabled={applying}
          className="flex-1 py-2 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50"
        >
          {applying ? 'Wird angewendet...' : `${accepted.size} Änderungen übernehmen`}
        </button>
        <button onClick={onCancel} disabled={applying} className="px-4 py-2 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
          Abbrechen
        </button>
      </div>
    </div>
  );
}
