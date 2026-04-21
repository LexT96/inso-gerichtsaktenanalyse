import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentJobs, type DocumentJob } from '../../hooks/useDocumentJobs';

const SOURCE_LABELS: Record<string, string> = {
  beschluss: 'Beschluss',
  insolvenzantrag: 'Insolvenzantrag',
  pzu: 'PZU',
  handelsregister: 'Handelsregister',
  meldeauskunft: 'Meldeauskunft',
  fragebogen: 'Fragebogen',
  grundbuch: 'Grundbuch',
  gerichtsvollzieher: 'Gerichtsvollzieher',
  vollstreckungsportal: 'Vollstreckungsportal',
  forderungstabelle: 'Forderungsanmeldung',
  vermoegensverzeichnis: 'Vermögensverzeichnis',
  gutachterbestellung: 'Gutachterbestellung',
  sonstiges: 'Sonstiges',
};

function labelForJob(j: DocumentJob): string {
  const type = SOURCE_LABELS[j.sourceType] ?? j.sourceType;
  return `${type} — ${j.filename}`;
}

export function DocumentJobsBadge() {
  const { jobs, dismiss } = useDocumentJobs();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  const active = jobs.filter(j => j.status === 'pending' || j.status === 'processing');
  const completed = jobs.filter(j => j.status === 'completed');
  const failed = jobs.filter(j => j.status === 'failed');

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (jobs.length === 0) return null;

  const openJob = (j: DocumentJob) => {
    dismiss(j.docId);
    setOpen(false);
    navigate(`/dashboard?id=${j.extractionId}&mergeDoc=${j.docId}`);
  };

  // Pick the "primary" status for the badge look
  let badgeText: string;
  let badgeClass: string;
  if (active.length > 0) {
    const a = active[0];
    badgeText = active.length === 1
      ? `Analyse läuft… ${a.progress}%`
      : `${active.length} Analysen laufen…`;
    badgeClass = 'border border-accent/50 text-accent bg-transparent hover:bg-accent/[0.06]';
  } else if (completed.length > 0) {
    badgeText = completed.length === 1 ? '✓ Ergebnis bereit' : `✓ ${completed.length} Ergebnisse bereit`;
    badgeClass = 'bg-emerald-600 text-white border border-emerald-700 hover:bg-emerald-500';
  } else {
    badgeText = failed.length === 1 ? 'Analyse fehlgeschlagen' : `${failed.length} fehlgeschlagen`;
    badgeClass = 'bg-red-600 text-white border border-red-700 hover:bg-red-500';
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 ${badgeClass} rounded-md px-3 py-1.5 text-[9px] font-mono uppercase tracking-wider transition-colors`}
        title="Dokument-Analysen"
      >
        {active.length > 0 && (
          <span className="w-2 h-2 border border-accent border-t-transparent rounded-full animate-spin" />
        )}
        {badgeText}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-surface border border-border rounded-lg shadow-xl z-50 py-1">
          {active.map(j => (
            <div key={`a-${j.docId}`} className="px-3 py-2 border-b border-border/60 last:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-text truncate flex-1">{labelForJob(j)}</div>
                <div className="text-[10px] text-accent font-mono">{j.progress}%</div>
              </div>
              {j.message && <div className="text-[9px] text-text-muted mt-0.5 truncate">{j.message}</div>}
              <div className="mt-1 h-0.5 bg-border/40 rounded overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${j.progress}%` }} />
              </div>
            </div>
          ))}
          {completed.map(j => (
            <div key={`c-${j.docId}`} className="flex items-stretch border-b border-border/60 last:border-b-0 hover:bg-emerald-900/10">
              <button
                onClick={() => openJob(j)}
                className="flex-1 text-left px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] text-text truncate flex-1">{labelForJob(j)}</div>
                  <div className="text-[10px] text-emerald-400 font-mono">Fertig</div>
                </div>
                <div className="text-[9px] text-text-muted mt-0.5">Klicken, um Ergebnis zu prüfen</div>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); dismiss(j.docId); }}
                className="px-2 text-text-muted hover:text-text text-[14px] leading-none"
                title="Ausblenden"
              >
                ×
              </button>
            </div>
          ))}
          {failed.map(j => (
            <div key={`f-${j.docId}`} className="flex items-stretch border-b border-border/60 last:border-b-0">
              <div className="flex-1 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] text-text truncate flex-1">{labelForJob(j)}</div>
                  <div className="text-[10px] text-red-400 font-mono">Fehler</div>
                </div>
                {j.error && <div className="text-[9px] text-red-400 mt-0.5 truncate" title={j.error}>{j.error}</div>}
              </div>
              <button
                onClick={() => dismiss(j.docId)}
                className="px-2 text-text-muted hover:text-text text-[14px] leading-none"
                title="Ausblenden"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
