interface LoadingSpinnerProps {
  message?: string;
}

export function LoadingSpinner({ message }: LoadingSpinnerProps) {
  return (
    <div className="mt-3 p-3 px-4 bg-surface border border-border rounded-sm flex items-center gap-2.5">
      <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin-fast" />
      <span className="text-[11px] text-accent">{message}</span>
    </div>
  );
}
