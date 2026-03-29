import { useAuth } from '../../hooks/useAuth';

export function Header() {
  const { logout } = useAuth();

  return (
    <header className="bg-surface border-b border-border px-6 py-3 flex items-center gap-4 shadow-card">
      <img
        src="/demo/tbsl.png"
        alt="Professor Schmidt — Insolvenzverwalter Rechtsanwälte"
        className="h-8 object-contain"
      />
      <div className="w-px h-6 bg-border" />
      <div className="flex-1">
        <div className="text-[11px] font-semibold text-text font-sans tracking-wide">
          Aktenanalyse
        </div>
        <div className="text-[8px] text-text-muted tracking-[1.5px] uppercase font-mono">
          KI-Extraktion &middot; Quellenreferenzen &middot; Gutachten
        </div>
      </div>
      <button
        onClick={logout}
        className="bg-transparent border border-border rounded-md text-text-muted text-[9px] px-3 py-1 cursor-pointer font-mono hover:border-accent hover:text-accent transition-colors uppercase tracking-wider"
      >
        Abmelden
      </button>
    </header>
  );
}
