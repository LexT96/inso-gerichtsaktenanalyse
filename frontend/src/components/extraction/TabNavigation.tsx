interface TabDef {
  id: string;
  label: string;
  icon: string;
  badge?: number;
}

interface TabNavigationProps {
  tabs: TabDef[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  onNewFile: () => void;
}

export function TabNavigation({ tabs, activeTab, onTabChange, onNewFile }: TabNavigationProps) {
  return (
    <div className="flex gap-0.5 mb-3.5 overflow-x-auto border-b border-border pb-0">
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onTabChange(t.id)}
          className={`px-3.5 py-2 border-none rounded-t-sm text-[10px] font-semibold cursor-pointer font-mono flex items-center gap-1.5 whitespace-nowrap tracking-wide transition-colors
            ${activeTab === t.id
              ? 'bg-surface text-text border-b-2 border-b-accent'
              : 'bg-transparent text-text-muted border-b-2 border-b-transparent hover:text-text-dim'
            }`}
        >
          <span className="text-[11px]">{t.icon}</span> {t.label}
          {t.badge !== undefined && t.badge > 0 && (
            <span className={`rounded-sm px-1.5 text-[9px] font-bold text-white ${t.id === 'briefe' ? 'bg-ie-green' : 'bg-ie-red'}`}>
              {t.badge}
            </span>
          )}
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={onNewFile}
        className="px-3 py-1.5 border border-border rounded-sm bg-transparent text-text-muted text-[9px] cursor-pointer font-mono self-center mb-1 hover:border-accent hover:text-accent transition-colors"
      >
        NEUE AKTE
      </button>
    </div>
  );
}
