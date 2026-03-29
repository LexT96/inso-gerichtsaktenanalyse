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
      {/* Subtle grid */}
      <div
        className="fixed inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: `repeating-linear-gradient(0deg, #D1D5DB 0px, transparent 1px, transparent 32px),
            repeating-linear-gradient(90deg, #D1D5DB 0px, transparent 1px, transparent 32px)`,
        }}
      />

      <div
        className={`w-[400px] bg-surface border border-border/60 rounded-xl shadow-elevated relative
          ${shake ? 'animate-shake' : 'animate-fade-up'}`}
      >
        {/* Logo area */}
        <div className="px-10 pt-10 pb-6 text-center border-b border-border">
          <img
            src="/demo/tbsl.png"
            alt="Professor Schmidt"
            className="h-14 mx-auto mb-4 object-contain"
          />
          <div className="w-12 h-px bg-accent mx-auto mb-3" />
          <div className="text-[10px] text-text-muted tracking-[3px] uppercase font-mono">
            Aktenanalyse
          </div>
        </div>

        {/* Form */}
        <div className="px-10 py-8">
          <div className="mb-4">
            <label className="text-[9px] text-text-dim uppercase tracking-[2px] block mb-1.5 font-mono">
              Benutzer
            </label>
            <input
              value={user}
              onChange={e => { setUser(e.target.value); setErr(''); }}
              onKeyDown={e => e.key === 'Enter' && submit()}
              placeholder="benutzername"
              className="w-full p-2.5 px-3 bg-bg border border-border rounded-md text-text text-[12px] font-mono box-border"
            />
          </div>

          <div className="mb-6">
            <label className="text-[9px] text-text-dim uppercase tracking-[2px] block mb-1.5 font-mono">
              Passwort
            </label>
            <input
              type="password"
              value={pass}
              onChange={e => { setPass(e.target.value); setErr(''); }}
              onKeyDown={e => e.key === 'Enter' && submit()}
              placeholder="••••••••"
              className="w-full p-2.5 px-3 bg-bg border border-border rounded-md text-text text-[12px] font-mono box-border"
            />
          </div>

          {err && (
            <div className="p-2 px-3 mb-4 bg-ie-red-bg border border-ie-red-border rounded-md text-ie-red text-[10px] font-mono">
              {err}
            </div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full py-2.5 bg-accent border-none rounded-md text-white text-[10px] font-bold font-mono cursor-pointer tracking-[2px] uppercase hover:brightness-110 disabled:opacity-60 transition-all"
          >
            {loading ? 'Anmelden…' : 'Anmelden'}
          </button>
        </div>

        {/* Legal footer */}
        <div className="px-10 py-4 border-t border-border text-center text-[8px] text-text-muted leading-relaxed font-mono tracking-wide">
          § 43a BRAO &middot; § 2 BORA &middot; Art. 28 DSGVO<br />
          Alle Daten verbleiben innerhalb der EU
        </div>
      </div>
    </div>
  );
}
