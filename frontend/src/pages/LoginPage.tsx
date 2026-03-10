import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

export function LoginPage() {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const submit = async () => {
    if (!user || !pass) return;
    setLoading(true);
    setErr('');
    try {
      await login(user, pass);
      navigate('/dashboard');
    } catch {
      setErr('Ungültige Anmeldedaten');
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center font-mono">
      {/* Grid background */}
      <div
        className="fixed inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, #D1D5DB 0px, transparent 1px, transparent 24px),
            repeating-linear-gradient(90deg, #D1D5DB 0px, transparent 1px, transparent 24px)`,
        }}
      />

      <div
        className={`w-[380px] p-12 px-10 bg-surface border border-border rounded-sm relative
          ${shake ? 'animate-shake' : 'animate-fade-up'}`}
      >
        <div className="text-center mb-9">
          <img
            src="/demo/tbsl.png"
            alt="TBS Logo"
            className="h-12 mx-auto mb-4 object-contain"
          />
          <div className="text-[15px] font-semibold text-text tracking-wide">
            TBS Aktenanalyse
          </div>
          <div className="text-[10px] text-text-muted mt-1 tracking-[2px] uppercase">
            Vertraulich
          </div>
        </div>

        <div className="mb-4">
          <label className="text-[10px] text-text-dim uppercase tracking-[1.5px] block mb-1.5">
            Benutzer
          </label>
          <input
            value={user}
            onChange={e => { setUser(e.target.value); setErr(''); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="benutzername"
            className="w-full p-2.5 px-3 bg-bg border border-border rounded-sm text-text text-[13px] font-mono box-border"
          />
        </div>

        <div className="mb-6">
          <label className="text-[10px] text-text-dim uppercase tracking-[1.5px] block mb-1.5">
            Passwort
          </label>
          <input
            type="password"
            value={pass}
            onChange={e => { setPass(e.target.value); setErr(''); }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="••••••••"
            className="w-full p-2.5 px-3 bg-bg border border-border rounded-sm text-text text-[13px] font-mono box-border"
          />
        </div>

        {err && (
          <div className="p-2 px-3 mb-4 bg-ie-red-bg border border-ie-red-border rounded-sm text-ie-red text-[11px]">
            {err}
          </div>
        )}

        <button
          onClick={submit}
          disabled={loading}
          className="w-full py-2.5 bg-accent border-none rounded-sm text-bg text-xs font-bold font-mono cursor-pointer tracking-wide uppercase hover:brightness-110 disabled:opacity-60"
        >
          {loading ? 'Anmelden…' : 'Anmelden'}
        </button>

        <div className="text-center mt-6 text-[9px] text-text-muted leading-relaxed">
          § 43a BRAO · § 2 BORA · Art. 28 DSGVO<br />
          Alle Daten verbleiben innerhalb der EU
        </div>
      </div>
    </div>
  );
}
