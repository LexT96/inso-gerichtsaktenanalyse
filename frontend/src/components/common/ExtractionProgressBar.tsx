interface ExtractionProgressBarProps {
  progress: number;
  message: string;
  /** Compact variant for the header bar */
  compact?: boolean;
}

export function ExtractionProgressBar({ progress, message, compact }: ExtractionProgressBarProps) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 bg-accent/10 border border-accent/30 rounded-md">
        <div className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin-fast flex-shrink-0" />
        <span className="text-[9px] text-accent font-mono truncate max-w-[200px]">{message}</span>
        <span className="text-[9px] text-accent/60 font-mono">{Math.round(progress)}%</span>
      </div>
    );
  }

  return (
    <div className="mt-3 p-5 bg-surface border border-accent/30 rounded-lg shadow-card">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin-fast flex-shrink-0" />
        <span className="text-[13px] text-accent font-sans font-semibold">Extraktion läuft</span>
        <span className="text-[11px] text-accent/60 font-mono ml-auto">{Math.round(progress)}%</span>
      </div>
      <div className="h-2 bg-surface-high rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      <div className="mt-2">
        <span className="text-[11px] text-text-muted font-mono">{message}</span>
      </div>
    </div>
  );
}
