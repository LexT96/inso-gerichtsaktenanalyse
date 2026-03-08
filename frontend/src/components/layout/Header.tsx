import { useAuth } from '../../hooks/useAuth';

export function Header() {
  const { logout } = useAuth();

  return (
    <div className="bg-surface border-b border-border px-6 py-3 flex items-center gap-3.5">
      <div className="w-9 h-9 rounded-sm bg-gradient-to-br from-accent to-accent-dim flex items-center justify-center text-xl font-extrabold text-bg">
        §
      </div>
      <div className="flex-1">
        <div className="text-sm font-bold text-text font-sans">
          InsolvenzAkte Extraktor
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
