import { useState, type ReactNode } from 'react';

interface SectionProps {
  title: string;
  icon: string;
  children: ReactNode;
  count?: number;
  defaultOpen?: boolean;
}

export function Section({ title, icon, children, count, defaultOpen = true }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-surface border border-border rounded-sm mb-2.5 overflow-hidden">
      <div
        onClick={() => setOpen(!open)}
        className={`px-4 py-2.5 flex items-center gap-2.5 cursor-pointer select-none ${open ? 'border-b border-border' : ''}`}
      >
        <span className="text-sm w-5 text-center">{icon}</span>
        <span className="text-xs font-semibold text-text font-sans flex-1">{title}</span>
        {count !== undefined && (
          <span className="text-[9px] px-1.5 py-px rounded-sm font-bold bg-surface-high text-text-dim border border-border font-mono">
            {count}
          </span>
        )}
        <span className="text-text-muted text-[10px]">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="p-2 px-4">{children}</div>}
    </div>
  );
}
