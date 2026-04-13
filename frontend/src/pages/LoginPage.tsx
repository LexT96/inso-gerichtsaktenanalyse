import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

type View = 'login' | 'register';

export function LoginPage() {
  const [view, setView] = useState<View>('login');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regName, setRegName] = useState('');
  const [err, setErr] = useState('');
  const [success, setSuccess] = useState('');
  const [shake, setShake] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login, loginWithEntra, register, authMode } = useAuth();
  const navigate = useNavigate();

  const submitLocal = async () => {
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

  const submitEntra = async () => {
    setLoading(true);
    setErr('');
    try {
      await loginWithEntra();
      navigate('/dashboard');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Entra login error:', e);
      setErr(`Microsoft-Anmeldung fehlgeschlagen: ${msg}`);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  };

  const submitRegister = async () => {
    if (!regEmail || !regPass || !regName) return;
    setLoading(true);
    setErr('');
    setSuccess('');
    try {
      await register(regEmail, regPass, regName);
      setSuccess('Konto erstellt. Sie können sich jetzt anmelden.');
      setView('login');
      setUser(regEmail);
      setRegEmail('');
      setRegPass('');
      setRegName('');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        || 'Registrierung fehlgeschlagen';
      setErr(msg);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  };

  const showEntra = authMode === 'hybrid';

  const inputClass = 'w-full p-2.5 px-3 bg-bg border border-border rounded-md text-text text-[12px] font-mono box-border';
  const labelClass = 'text-[9px] text-text-dim uppercase tracking-[2px] block mb-1.5 font-mono';
  const btnClass = 'w-full py-2.5 bg-accent border-none rounded-md text-white text-[10px] font-bold font-mono cursor-pointer tracking-[2px] uppercase hover:brightness-110 disabled:opacity-60 transition-all';

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
        <div className="px-10 pt-10 pb-6 text-center border-b border-border/60">
          <img
            src="/demo/kp-logo.png"
            alt="KlareProzesse"
            className="h-14 mx-auto mb-5 object-contain"
          />
          <div className="w-10 h-px bg-gradient-to-r from-transparent via-accent to-transparent mx-auto mb-3" />
          <div className="text-[10px] text-text-muted tracking-[3px] uppercase font-mono">
            Aktenanalyse
          </div>
        </div>

        {/* Auth forms */}
        <div className="px-10 py-8">
          {authMode === null ? (
            /* Loading state while detecting auth mode */
            <div className="flex justify-center py-4">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin-fast" />
            </div>
          ) : view === 'register' ? (
            <>
              {/* Registration form */}
              <div className="text-center mb-6">
                <div className="text-[11px] text-text-dim mb-1 font-mono">Konto erstellen</div>
              </div>

              <div className="mb-4">
                <label className={labelClass}>Name</label>
                <input
                  value={regName}
                  onChange={e => { setRegName(e.target.value); setErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && submitRegister()}
                  placeholder="Max Mustermann"
                  className={inputClass}
                />
              </div>

              <div className="mb-4">
                <label className={labelClass}>E-Mail</label>
                <input
                  type="email"
                  value={regEmail}
                  onChange={e => { setRegEmail(e.target.value); setErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && submitRegister()}
                  placeholder="name@kanzlei.de"
                  className={inputClass}
                />
              </div>

              <div className="mb-6">
                <label className={labelClass}>Passwort</label>
                <input
                  type="password"
                  value={regPass}
                  onChange={e => { setRegPass(e.target.value); setErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && submitRegister()}
                  placeholder="mind. 8 Zeichen"
                  className={inputClass}
                />
              </div>

              {err && (
                <div className="p-2 px-3 mb-4 bg-ie-red-bg border border-ie-red-border rounded-md text-ie-red text-[10px] font-mono">
                  {err}
                </div>
              )}

              <button onClick={submitRegister} disabled={loading} className={btnClass}>
                {loading ? 'Registrieren...' : 'Registrieren'}
              </button>

              <div className="mt-4 text-center">
                <button
                  onClick={() => { setView('login'); setErr(''); setSuccess(''); }}
                  className="text-[10px] text-text-dim hover:text-accent transition-colors font-mono bg-transparent border-none cursor-pointer"
                >
                  Bereits ein Konto? Anmelden
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Microsoft SSO (shown in hybrid mode) */}
              {showEntra && (
                <>
                  <div className="text-center mb-4">
                    <div className="text-[11px] text-text-dim mb-1 font-mono">
                      Anmeldung über Microsoft 365
                    </div>
                  </div>
                  <button
                    onClick={submitEntra}
                    disabled={loading}
                    className={`${btnClass} flex items-center justify-center gap-2 mb-6`}
                  >
                    <svg width="16" height="16" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
                      <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                      <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                      <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                      <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                    </svg>
                    {loading ? 'Anmelden...' : 'Mit Microsoft anmelden'}
                  </button>

                  {/* Divider */}
                  <div className="flex items-center gap-3 mb-6">
                    <div className="flex-1 h-px bg-border/60" />
                    <span className="text-[9px] text-text-muted tracking-[2px] uppercase font-mono">oder</span>
                    <div className="flex-1 h-px bg-border/60" />
                  </div>
                </>
              )}

              {/* Email/password login */}
              <div className="mb-4">
                <label className={labelClass}>E-Mail</label>
                <input
                  value={user}
                  onChange={e => { setUser(e.target.value); setErr(''); setSuccess(''); }}
                  onKeyDown={e => e.key === 'Enter' && submitLocal()}
                  placeholder="name@kanzlei.de"
                  className={inputClass}
                />
              </div>

              <div className="mb-6">
                <label className={labelClass}>Passwort</label>
                <input
                  type="password"
                  value={pass}
                  onChange={e => { setPass(e.target.value); setErr(''); setSuccess(''); }}
                  onKeyDown={e => e.key === 'Enter' && submitLocal()}
                  placeholder="••••••••"
                  className={inputClass}
                />
              </div>

              {success && (
                <div className="p-2 px-3 mb-4 bg-green-50 border border-green-200 rounded-md text-green-700 text-[10px] font-mono">
                  {success}
                </div>
              )}

              {err && (
                <div className="p-2 px-3 mb-4 bg-ie-red-bg border border-ie-red-border rounded-md text-ie-red text-[10px] font-mono">
                  {err}
                </div>
              )}

              <button onClick={submitLocal} disabled={loading} className={btnClass}>
                {loading ? 'Anmelden...' : 'Anmelden'}
              </button>

              <div className="mt-4 text-center">
                <button
                  onClick={() => { setView('register'); setErr(''); setSuccess(''); }}
                  className="text-[10px] text-text-dim hover:text-accent transition-colors font-mono bg-transparent border-none cursor-pointer"
                >
                  Noch kein Konto? Registrieren
                </button>
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}
