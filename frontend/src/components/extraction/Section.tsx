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
    <div className="bg-surface border border-border/60 rounded-lg shadow-card mb-3 overflow-hidden">
      <div
        onClick={() => setOpen(!open)}
        className={`px-4 py-2.5 flex items-center gap-2.5 cursor-pointer select-none hover:bg-surface-high/50 transition-colors duration-150 border-l-2 border-l-transparent hover:border-l-accent/30 ${open ? 'border-l-accent/50' : ''}`}
      >
        <span className="text-sm w-5 text-center text-text-muted">{icon}</span>
        <span className="text-[13px] font-semibold text-text font-sans flex-1 tracking-tight">{title}</span>
        {count !== undefined && (
          <span className="text-[9px] px-2 py-0.5 rounded-full font-bold bg-surface-high text-text-dim border border-border/80 font-mono">
            {count}
          </span>
        )}
        <span className={`text-[10px] text-text-muted transition-transform duration-200 inline-block ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </div>
      <div className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="p-2.5 px-4 pt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}
