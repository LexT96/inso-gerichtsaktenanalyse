import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

interface HeaderProps {
  onExport?: () => void;
  onNewFile?: () => void;
}

export function Header({ onExport, onNewFile }: HeaderProps = {}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const navBtn = 'bg-transparent border border-border/80 rounded-md text-text-muted text-[9px] px-3.5 py-1.5 cursor-pointer font-mono hover:border-accent hover:text-accent hover:bg-accent/[0.03] transition-all uppercase tracking-wider';
  const navBtnActive = 'bg-transparent border border-accent rounded-md text-accent text-[9px] px-3.5 py-1.5 cursor-pointer font-mono uppercase tracking-wider';

  return (
    <header className="bg-surface border-b border-border px-6 py-2.5 flex items-center gap-5 shadow-card">
      <div className="flex items-center gap-3.5">
        <img
          src="/demo/tbsl.png"
          alt="Professor Schmidt — Insolvenzverwalter Rechtsanwälte"
          className="h-9 object-contain"
        />
        <div className="w-px h-7 bg-gradient-to-b from-transparent via-border to-transparent" />
        <div className="flex flex-col">
          <div className="text-[13px] font-bold text-text font-sans tracking-tight leading-tight">
            Aktenanalyse
          </div>
          <div className="text-[8px] text-text-muted tracking-[2px] uppercase font-mono mt-px">
            Extraktion &middot; Quellen &middot; Gutachten
          </div>
        </div>
      </div>
      <div className="flex-1" />
      {onExport && (
        <button onClick={onExport} className={navBtn}>
          Export
        </button>
      )}
      {onNewFile && (
        <button onClick={onNewFile} className={navBtn}>
          Neue Akte
        </button>
      )}
      {user?.role === 'admin' && (
        <button
          onClick={() => navigate('/admin')}
          className={location.pathname === '/admin' ? navBtnActive : navBtn}
        >
          Admin
        </button>
      )}
      <button
        onClick={logout}
        className={navBtn}
      >
        Abmelden
      </button>
    </header>
  );
}
