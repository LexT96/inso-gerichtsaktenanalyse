type BadgeType = 'found' | 'missing' | 'partial' | 'bereit' | 'fehlt' | 'entfaellt' | 'unverified';

const badgeStyles: Record<BadgeType, { bg: string; text: string; border: string; label: string }> = {
  found:     { bg: 'bg-ie-green-bg',  text: 'text-ie-green',  border: 'border-ie-green-border',  label: 'GEFUNDEN' },
  missing:   { bg: 'bg-ie-red-bg',    text: 'text-ie-red',    border: 'border-ie-red-border',    label: 'FEHLT' },
  partial:   { bg: 'bg-ie-amber-bg',  text: 'text-ie-amber',  border: 'border-ie-amber-border',  label: 'TEILWEISE' },
  bereit:    { bg: 'bg-ie-green-bg',  text: 'text-ie-green',  border: 'border-ie-green-border',  label: 'BEREIT' },
  fehlt:     { bg: 'bg-ie-red-bg',    text: 'text-ie-red',    border: 'border-ie-red-border',    label: 'FEHLT' },
  entfaellt: { bg: 'bg-ie-blue-bg',   text: 'text-ie-blue',   border: 'border-ie-blue-border',   label: 'ENTFÄLLT' },
  unverified: { bg: 'bg-ie-amber-bg', text: 'text-ie-amber', border: 'border-ie-amber-border', label: 'UNGEPRÜFT' },
};

interface BadgeProps {
  type: BadgeType;
}

function BadgeIndicator({ type }: { type: BadgeType }) {
  if (type === 'bereit' || type === 'found') {
    return <span className="w-1.5 h-1.5 rounded-full bg-current inline-block mr-1" />;
  }
  if (type === 'fehlt' || type === 'missing') {
    return <span className="w-1.5 h-1.5 rounded-full border border-current inline-block mr-1" />;
  }
  if (type === 'entfaellt') {
    return <span className="w-2 h-px bg-current inline-block mr-1" />;
  }
  return null;
}

export function Badge({ type }: BadgeProps) {
  const s = badgeStyles[type] || badgeStyles.missing;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-sm text-[9px] font-bold tracking-wide border font-mono ${s.bg} ${s.text} ${s.border}`}>
      <BadgeIndicator type={type} />
      {s.label}
    </span>
  );
}
