import { useState, useMemo } from 'react';

interface TabDef {
  id: string;
  label: string;
  icon: string;
  badge?: number;
  group?: string;
}

interface GroupDef {
  id: string;
  label: string;
}

interface TabNavigationProps {
  tabs: TabDef[];
  groups: GroupDef[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  onNewFile: () => void;
  onExport?: () => void;
  onAddDocument?: () => void;
  /** Per-group progress: 'complete' | 'partial' | 'empty' */
  groupProgress?: Record<string, 'complete' | 'partial' | 'empty'>;
}

export function TabNavigation({
  tabs, groups, activeTab, onTabChange, onNewFile, onExport, onAddDocument, groupProgress,
}: TabNavigationProps) {
  // Determine which group the active tab belongs to
  const activeGroup = useMemo(() => {
    const activeTabDef = tabs.find(t => t.id === activeTab);
    return activeTabDef?.group || groups[0]?.id || '';
  }, [tabs, activeTab, groups]);

  const [selectedGroup, setSelectedGroup] = useState(activeGroup);

  // Keep selectedGroup in sync when activeTab changes externally
  if (activeGroup !== selectedGroup) {
    const tabInSelected = tabs.find(t => t.id === activeTab && t.group === selectedGroup);
    if (!tabInSelected) {
      // Active tab moved to a different group — follow it
      if (selectedGroup !== activeGroup) setSelectedGroup(activeGroup);
    }
  }

  // Sub-tabs for the selected group
  const subTabs = useMemo(
    () => tabs.filter(t => t.group === selectedGroup),
    [tabs, selectedGroup],
  );

  const handleGroupClick = (groupId: string) => {
    setSelectedGroup(groupId);
    // Auto-select first tab in group if current tab isn't in this group
    const currentInGroup = tabs.find(t => t.id === activeTab && t.group === groupId);
    if (!currentInGroup) {
      const firstInGroup = tabs.find(t => t.group === groupId);
      if (firstInGroup) onTabChange(firstInGroup.id);
    }
  };

  return (
    <div className="mb-3.5 sticky top-0 bg-bg/95 backdrop-blur-sm z-20 -mx-6 px-6 pt-1">
      {/* Main group bar */}
      <div className="flex items-center border-b border-border/40 pb-0">
        <div className="flex items-end gap-0.5 flex-1">
          {groups.map(g => {
            const isActive = selectedGroup === g.id;
            const progress = groupProgress?.[g.id] || 'empty';
            return (
              <button
                key={g.id}
                onClick={() => handleGroupClick(g.id)}
                className={`px-4 py-2.5 border-none rounded-t-md text-[11px] font-semibold cursor-pointer font-mono flex items-center gap-2 whitespace-nowrap tracking-wide transition-all duration-150
                  ${isActive
                    ? 'bg-surface text-text border-b-[2px] border-b-accent -mb-px'
                    : 'bg-transparent text-text-muted border-b-[2px] border-b-transparent hover:text-text hover:bg-surface/50 -mb-px'
                  }`}
              >
                <span className={`w-[6px] h-[6px] rounded-full inline-block ${
                  progress === 'complete' ? 'bg-ie-green' :
                  progress === 'partial' ? 'bg-ie-amber' :
                  'bg-border'
                }`} />
                {g.label}
                <GroupBadge tabs={tabs} groupId={g.id} />
              </button>
            );
          })}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 mb-1">
          {onAddDocument && (
            <button onClick={onAddDocument}
              className="px-2.5 py-1.5 border border-border/80 rounded-md bg-transparent text-text-muted text-[9px] cursor-pointer font-mono hover:border-accent hover:text-accent hover:bg-accent/[0.03] transition-all tracking-wider">
              + DOK
            </button>
          )}
          {onExport && (
            <button onClick={onExport}
              className="px-2.5 py-1.5 border border-border/80 rounded-md bg-transparent text-text-muted text-[9px] cursor-pointer font-mono hover:border-accent hover:text-accent hover:bg-accent/[0.03] transition-all tracking-wider">
              ↗
            </button>
          )}
          <button onClick={onNewFile}
            className="px-2.5 py-1.5 border border-border/80 rounded-md bg-transparent text-text-muted text-[9px] cursor-pointer font-mono hover:border-accent hover:text-accent hover:bg-accent/[0.03] transition-all tracking-wider">
            NEU
          </button>
        </div>
      </div>

      {/* Sub-tabs for selected group */}
      <div className="flex items-center gap-1 py-1 px-1 bg-surface-high/30 border-b border-border/20">
        {subTabs.map(t => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`px-3 py-1.5 border-none rounded-md text-[10px] font-mono cursor-pointer whitespace-nowrap transition-all duration-150 flex items-center gap-1.5
              ${activeTab === t.id
                ? 'bg-accent/10 text-accent font-semibold'
                : 'bg-transparent text-text-muted hover:text-text hover:bg-surface/60'
              }`}
          >
            {t.label}
            <TabBadge tab={t} />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Aggregate badge for a group — sum of all sub-tab badges */
function GroupBadge({ tabs, groupId }: { tabs: TabDef[]; groupId: string }) {
  const total = tabs
    .filter(t => t.group === groupId)
    .reduce((sum, t) => sum + (t.badge || 0), 0);
  if (total <= 0) return null;
  return (
    <span className="rounded-full px-1.5 min-w-[16px] text-center text-[8px] font-bold text-white bg-ie-amber">
      {total}
    </span>
  );
}

function TabBadge({ tab }: { tab: TabDef }) {
  if (!tab.badge || tab.badge <= 0) return null;
  return (
    <span className={`rounded-full px-1.5 min-w-[16px] text-center text-[8px] font-bold text-white ${tab.id === 'briefe' ? 'bg-ie-green' : 'bg-ie-red'}`}>
      {tab.badge}
    </span>
  );
}
