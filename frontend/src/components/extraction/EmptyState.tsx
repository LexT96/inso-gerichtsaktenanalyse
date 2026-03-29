interface EmptyStateProps {
  icon: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="bg-surface border border-border/60 rounded-lg shadow-card py-10 px-6 flex flex-col items-center text-center">
      <div className="w-10 h-10 rounded-full bg-bg border border-border flex items-center justify-center text-text-muted text-sm mb-3 shadow-card">
        {icon}
      </div>
      <span className="text-[11px] text-text-dim font-mono">{title}</span>
      {description && (
        <span className="text-[10px] text-text-muted font-mono mt-1 max-w-xs leading-relaxed">
          {description}
        </span>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-3 px-3 py-1.5 border border-border rounded-md text-[10px] font-mono text-text-muted hover:border-accent hover:text-accent transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
