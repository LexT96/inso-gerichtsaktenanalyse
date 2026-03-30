import { useState, useRef, useEffect, useCallback } from 'react';

interface TabDef {
  id: string;
  label: string;
  icon: string;
  badge?: number;
  group?: string;
}

interface TabNavigationProps {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  onNewFile: () => void;
  onExport?: () => void;
}

export function TabNavigation({ tabs, activeTab, onTabChange, onNewFile, onExport }: TabNavigationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [visibleCount, setVisibleCount] = useState(tabs.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Measure which tabs fit
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    // Available width = container width minus action buttons area (~180px)
    const actionBtns = container.querySelector('[data-actions]');
    const actionsWidth = actionBtns ? actionBtns.getBoundingClientRect().width + 16 : 180;
    const overflowBtnWidth = 56; // "+N" button space
    const available = container.getBoundingClientRect().width - actionsWidth - overflowBtnWidth;

    let totalWidth = 0;
    let count = 0;
    for (const tab of tabs) {
      const el = tabsRef.current.get(tab.id);
      if (!el) break; // Stop at first unmeasured tab (not yet rendered)
      const w = el.getBoundingClientRect().width + 2; // +2 for gap
      if (totalWidth + w > available) break;
      totalWidth += w;
      count++;
    }
    // Always show at least 3, but never more than what fits
    if (count > 0) {
      setVisibleCount(Math.max(3, count));
    }
  }, [tabs]);

  useEffect(() => {
    measure();
    const obs = new ResizeObserver(measure);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [measure]);

  // Close overflow on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [overflowOpen]);

  const visibleTabs = tabs.slice(0, visibleCount);
  const overflowTabs = tabs.slice(visibleCount);
  const activeInOverflow = overflowTabs.some(t => t.id === activeTab);

  // Detect group boundaries for separators
  const groupBoundaries = new Set<number>();
  for (let i = 1; i < visibleTabs.length; i++) {
    if (visibleTabs[i].group && visibleTabs[i].group !== visibleTabs[i - 1].group) {
      groupBoundaries.add(i);
    }
  }

  return (
    <div ref={containerRef} className="flex items-end gap-0 mb-3.5 pb-0 relative border-b border-border/40 sticky top-0 bg-bg/95 backdrop-blur-sm z-20 -mx-6 px-6 pt-1 flex-nowrap">
      {/* Visible tabs */}
      {visibleTabs.map((t, i) => (
        <div key={t.id} className="flex items-end">
          {groupBoundaries.has(i) && (
            <div className="w-px h-5 bg-border/50 mx-1 self-center mb-1" />
          )}
          <button
            ref={el => { if (el) tabsRef.current.set(t.id, el); else tabsRef.current.delete(t.id); }}
            onClick={() => onTabChange(t.id)}
            className={`px-3 py-2.5 border-none rounded-t-md text-[10px] font-semibold cursor-pointer font-mono flex items-center gap-1.5 whitespace-nowrap tracking-wide transition-all duration-150
              ${activeTab === t.id
                ? 'bg-surface text-text border-b-[2px] border-b-accent shadow-sm -mb-px'
                : 'bg-transparent text-text-muted border-b-[2px] border-b-transparent hover:text-text hover:bg-surface/50 -mb-px'
              }`}
          >
            <span className="text-[11px]">{t.icon}</span> {t.label}
            <TabBadge tab={t} />
          </button>
        </div>
      ))}

      {/* Overflow button */}
      {overflowTabs.length > 0 && (
        <div ref={overflowRef} className="relative flex items-end">
          <button
            onClick={() => setOverflowOpen(o => !o)}
            className={`px-2.5 py-2.5 border-none rounded-t-md text-[10px] font-bold cursor-pointer font-mono whitespace-nowrap tracking-wide transition-all duration-150
              ${activeInOverflow || overflowOpen
                ? 'bg-surface text-accent border-b-[2px] border-b-accent -mb-px'
                : 'bg-transparent text-text-muted border-b-[2px] border-b-transparent hover:text-text -mb-px'
              }`}
            title={overflowTabs.map(t => t.label).join(', ')}
          >
            +{overflowTabs.length}
          </button>

          {/* Dropdown */}
          {overflowOpen && (
            <div className="absolute top-full right-0 mt-1 bg-surface border border-border/60 rounded-lg shadow-dropdown z-50 min-w-[160px] py-1">
              {overflowTabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => { onTabChange(t.id); setOverflowOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-[10px] font-mono flex items-center gap-2 transition-colors
                    ${activeTab === t.id
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-muted hover:bg-bg hover:text-text'
                    }`}
                >
                  <span className="text-[11px] w-4 text-center">{t.icon}</span>
                  {t.label}
                  <TabBadge tab={t} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Spacer + action buttons */}
      <div className="flex-1" />
      <div data-actions className="flex items-center gap-1.5 mb-1">
        {onExport && (
          <button
            onClick={onExport}
            className="px-3 py-1.5 border border-border/80 rounded-md bg-transparent text-text-muted text-[9px] cursor-pointer font-mono hover:border-accent hover:text-accent hover:bg-accent/[0.03] transition-all tracking-wider"
          >
            EXPORT
          </button>
        )}
        <button
          onClick={onNewFile}
          className="px-3 py-1.5 border border-border/80 rounded-md bg-transparent text-text-muted text-[9px] cursor-pointer font-mono hover:border-accent hover:text-accent hover:bg-accent/[0.03] transition-all tracking-wider"
        >
          NEU
        </button>
      </div>
    </div>
  );
}

function TabBadge({ tab }: { tab: TabDef }) {
  if (!tab.badge || tab.badge <= 0) return null;
  return (
    <span className={`rounded-full px-1.5 min-w-[18px] text-center text-[9px] font-bold text-white ${tab.id === 'briefe' ? 'bg-ie-green' : 'bg-ie-red'}`}>
      {tab.badge}
    </span>
  );
}
