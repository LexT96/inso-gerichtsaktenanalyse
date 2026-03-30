interface StatsCardProps {
  label: string;
  value: string | number;
  colorClass: string;
}

function StatsCard({ label, value, colorClass }: StatsCardProps) {
  return (
    <div className="bg-surface border border-border/60 rounded-lg shadow-card py-3.5 px-4 text-center flex-1">
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
}

export function StatsBar({ found, missing, total, lettersReady, lettersNA, lettersOpen }: StatsBarProps) {
  const quote = total ? Math.round((found / total) * 100) : 0;

  return (
    <div className="flex gap-2 mb-3.5">
      <StatsCard label="Gefunden" value={found} colorClass="text-ie-green" />
      <StatsCard label="Fehlend" value={missing} colorClass="text-ie-red" />
      <StatsCard label="Quote" value={`${quote}%`} colorClass="text-ie-blue" />
      <StatsCard label="Anschreiben bereit" value={lettersReady} colorClass="text-ie-green" />
      <StatsCard label="Entfällt" value={lettersNA} colorClass="text-ie-blue" />
      <StatsCard label="Noch offen" value={lettersOpen} colorClass="text-ie-amber" />
    </div>
  );
}
