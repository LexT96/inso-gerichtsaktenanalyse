import { useAuth } from '../../hooks/useAuth';

export function Header() {
  const { logout } = useAuth();

  return (
    <div className="bg-surface border-b border-border px-6 py-3 flex items-center gap-3.5">
      <img
        src="/demo/tbsl.png"
        alt="TBS Logo"
        className="h-9 object-contain mr-3"
      />
      <div className="flex-1">
        <div className="text-sm font-bold text-text font-sans">
          TBS Aktenanalyse
        </div>
        <div className="text-[9px] text-text-muted tracking-[1.5px] uppercase">
          KI-Analyse · Quellenreferenzen · Standardanschreiben
        </div>
      </div>
      <button
        onClick={logout}
        className="bg-transparent border border-border rounded-sm text-text-muted text-[10px] px-3 py-1.5 cursor-pointer font-mono hover:border-accent hover:text-accent transition-colors"
      >
        Abmelden
      </button>
    </div>
  );
}
