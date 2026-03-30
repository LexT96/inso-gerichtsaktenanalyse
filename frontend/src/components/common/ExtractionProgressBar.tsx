interface ExtractionProgressBarProps {
  progress: number;
  message: string;
}

export function ExtractionProgressBar({ progress, message }: ExtractionProgressBarProps) {
  return (
    <div className="mt-3 p-4 bg-surface border border-border/60 rounded-lg shadow-card">
      <div className="h-1.5 bg-surface-high rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin-fast flex-shrink-0" />
        <span className="text-[11px] text-accent">{message}</span>
      </div>
    </div>
  );
}
