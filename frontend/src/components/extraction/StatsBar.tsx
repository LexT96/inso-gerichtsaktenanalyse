import { useState } from 'react';
import type { FieldDetail } from '../../pages/DashboardPage';

interface StatsCardProps {
  label: string;
  value: string | number;
  colorClass: string;
  onClick?: () => void;
  active?: boolean;
}

function StatsCard({ label, value, colorClass, onClick, active }: StatsCardProps) {
  return (
    <div
      className={`bg-surface border rounded-lg shadow-card py-3.5 px-4 text-center flex-1 transition-all
        ${onClick ? 'cursor-pointer hover:shadow-elevated' : ''}
        ${active ? 'border-accent ring-1 ring-accent/30' : 'border-border/60'}`}
      onClick={onClick}
    >
      <div className={`text-2xl font-bold font-mono ${colorClass}`}>{value}</div>
      <div className="text-[9px] text-text-muted mt-1 uppercase tracking-wider font-mono">{label}</div>
    </div>
  );
}

interface StatsBarProps {
  found: number;
  missing: number;
  total: number;
  lettersReady: number;
  lettersNA: number;
  lettersOpen: number;
  fields?: FieldDetail[];
}

export function StatsBar({ found, lettersReady, lettersNA, lettersOpen, fields }: StatsBarProps) {
  const [expanded, setExpanded] = useState(false);

  const foundFields = fields?.filter(f => f.filled) || [];

  return (
    <div className="mb-3.5">
      <div className="flex gap-2">
        <StatsCard
          label="Gefunden"
          value={found}
          colorClass="text-ie-green"
          onClick={() => setExpanded(prev => !prev)}
          active={expanded}
        />
        <StatsCard label="Anschreiben bereit" value={lettersReady} colorClass="text-ie-green" />
        <StatsCard label="Entfällt" value={lettersNA} colorClass="text-text-dim" />
        <StatsCard label="Noch offen" value={lettersOpen} colorClass="text-ie-amber" />
      </div>

      {expanded && fields && (
        <div className="mt-2 bg-surface border border-border/60 rounded-lg shadow-card p-4 animate-fade-up">
          <div className="text-[10px] text-text-muted font-mono uppercase tracking-wide mb-2">
            {foundFields.length} gefundene Felder
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 max-h-64 overflow-y-auto">
            {foundFields.map(f => (
              <div key={f.path} className="flex items-center gap-1.5 text-xs font-mono">
                <span className="text-ie-green">{'\u2713'}</span>
                <span className="text-text-dim truncate" title={f.path}>
                  {f.label}
                </span>
                {f.value && (
                  <span className="text-text-muted truncate ml-auto text-[10px] max-w-[120px]" title={f.value}>
                    {f.value.length > 25 ? f.value.slice(0, 25) + '\u2026' : f.value}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
