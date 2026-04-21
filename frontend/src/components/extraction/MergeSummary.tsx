import { useState } from 'react';
import type { MergeDiff, MergeFieldChange } from '../../types/extraction';

/** Human-readable labels for dotted field paths */
const FIELD_LABELS: Record<string, string> = {
  'verfahrensdaten.aktenzeichen': 'Aktenzeichen',
  'verfahrensdaten.gericht': 'Gericht',
  'verfahrensdaten.richter': 'Richter',
  'verfahrensdaten.beschlussdatum': 'Beschlussdatum',
  'verfahrensdaten.antragsdatum': 'Antragsdatum',
  'verfahrensdaten.antragsart': 'Antragsart',
  'verfahrensdaten.eroeffnungsgrund': 'Eröffnungsgrund',
  'verfahrensdaten.zustellungsdatum_schuldner': 'Zustellungsdatum',
  'verfahrensdaten.verfahrensart': 'Verfahrensart',
  'verfahrensdaten.verfahrensstadium': 'Verfahrensstadium',
  'verfahrensdaten.eigenverwaltung': 'Eigenverwaltung',
  'verfahrensdaten.internationaler_bezug': 'Internationaler Bezug',
  'schuldner.name': 'Schuldner Name',
  'schuldner.vorname': 'Schuldner Vorname',
  'schuldner.firma': 'Firma',
  'schuldner.rechtsform': 'Rechtsform',
  'schuldner.geburtsdatum': 'Geburtsdatum',
  'schuldner.aktuelle_adresse': 'Aktuelle Adresse',
  'schuldner.betriebsstaette_adresse': 'Betriebsstätte',
  'schuldner.handelsregisternummer': 'HRB-Nummer',
  'schuldner.familienstand': 'Familienstand',
  'schuldner.telefon': 'Telefon',
  'schuldner.email': 'E-Mail',
  'schuldner.finanzamt': 'Finanzamt',
  'schuldner.steuernummer': 'Steuernummer',
  'antragsteller.name': 'Antragsteller',
  'antragsteller.adresse': 'Antragsteller Adresse',
  'gutachterbestellung.gutachter_name': 'Gutachter',
  'gutachterbestellung.gutachter_kanzlei': 'Gutachter Kanzlei',
  'gutachterbestellung.gutachter_adresse': 'Gutachter Adresse',
  'gutachterbestellung.bestellungsdatum': 'Bestellungsdatum',
  'gutachterbestellung.frist_gutachten': 'Frist Gutachten',
  'gutachterbestellung.sicherungsmassnahmen': 'Sicherungsmaßnahmen',
  'gutachterbestellung.befugnisse': 'Befugnisse',
  'ermittlungsergebnisse.grundbuch.ergebnis': 'Grundbuch',
  'ermittlungsergebnisse.grundbuch.datum': 'Grundbuch Datum',
  'ermittlungsergebnisse.gerichtsvollzieher.ergebnis': 'Gerichtsvollzieher',
  'ermittlungsergebnisse.meldeauskunft.ergebnis': 'Meldeauskunft',
  'ermittlungsergebnisse.vollstreckungsportal.ergebnis': 'Vollstreckungsportal',
};

function humanLabel(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  // Fallback: take last segment, replace underscores, capitalize
  const last = path.split('.').pop() || path;
  return last.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatValue(wert: unknown): string {
  if (wert === null || wert === undefined) return '—';
  if (typeof wert === 'string') return wert;
  if (typeof wert === 'boolean') return wert ? 'Ja' : 'Nein';
  if (typeof wert === 'number') return String(wert);
  if (Array.isArray(wert)) return wert.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('; ');
  if (typeof wert === 'object') {
    // SourcedValue-like: show wert
    const obj = wert as Record<string, unknown>;
    if ('wert' in obj) return formatValue(obj.wert);
    return JSON.stringify(wert);
  }
  return String(wert);
}

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
    <label className={`flex items-start gap-2 p-2.5 rounded border ${colors[variant]} cursor-pointer`}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-0.5 accent-accent" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-text-dim font-sans font-medium">{humanLabel(change.path)}</div>
        {change.oldWert !== undefined && (
          <div className="text-[11px] text-red-400 line-through mt-0.5">{formatValue(change.oldWert)}</div>
        )}
        <div className="text-[12px] text-text mt-0.5 leading-relaxed">{formatValue(change.wert)}</div>
        <div className="text-[9px] text-text-muted mt-1">{change.quelle}</div>
        {change.reason && <div className="text-[9px] text-text-dim italic">{change.reason}</div>}
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

  const arraySummary = diff.arraySummary;
  const arrayCount = arraySummary
    ? arraySummary.newEinzelforderungen + arraySummary.newAktivaPositionen + arraySummary.newAnfechtungVorgaenge
    : 0;
  const totalChanges = allChanges.length + diff.newForderungen.length + diff.updatedForderungen.length + arrayCount;

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
      {arraySummary && arrayCount > 0 && (
        <div className="p-2.5 rounded border border-emerald-800/40 bg-emerald-900/10 text-[11px] text-emerald-300 space-y-0.5">
          <div className="text-[10px] text-emerald-400 font-semibold mb-1">
            Werden automatisch übernommen (keine Konflikte)
          </div>
          {arraySummary.newEinzelforderungen > 0 && (
            <div>+ {arraySummary.newEinzelforderungen} neue Forderung{arraySummary.newEinzelforderungen === 1 ? '' : 'en'}</div>
          )}
          {arraySummary.newAktivaPositionen > 0 && (
            <div>+ {arraySummary.newAktivaPositionen} neue Aktiva-Position{arraySummary.newAktivaPositionen === 1 ? '' : 'en'}</div>
          )}
          {arraySummary.newAnfechtungVorgaenge > 0 && (
            <div>+ {arraySummary.newAnfechtungVorgaenge} neue{arraySummary.newAnfechtungVorgaenge === 1 ? 'r anfechtbarer Vorgang' : ' anfechtbare Vorgänge'}</div>
          )}
        </div>
      )}
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
          {applying
            ? 'Wird angewendet...'
            : accepted.size > 0
              ? `${accepted.size} Änderung${accepted.size === 1 ? '' : 'en'} übernehmen${arrayCount > 0 ? ` (+ ${arrayCount} auto)` : ''}`
              : arrayCount > 0
                ? `${arrayCount} Zeile${arrayCount === 1 ? '' : 'n'} übernehmen`
                : 'Übernehmen'}
        </button>
        <button onClick={onCancel} disabled={applying} className="px-4 py-2 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
          Abbrechen
        </button>
      </div>
    </div>
  );
}
