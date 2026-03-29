import { useState } from 'react';
import { apiClient } from '../../api/client';

interface ExportDialogProps {
  extractionId: number;
  filename: string;
  onClose: () => void;
}

export function ExportDialog({ extractionId, filename, onClose }: ExportDialogProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const strength = password.length >= 12 ? 'stark' : password.length >= 8 ? 'mittel' : 'schwach';
  const strengthColor = strength === 'stark' ? 'text-ie-green' : strength === 'mittel' ? 'text-ie-amber' : 'text-ie-red';

  const handleExport = async () => {
    if (password.length < 8) {
      setError('Passwort muss mindestens 8 Zeichen lang sein');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwörter stimmen nicht überein');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { data } = await apiClient.post(`/history/${extractionId}/export`, { password });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.replace(/\.pdf$/i, '') + '.iae';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onClose();
    } catch (err) {
      const msg = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      setError(msg || 'Export fehlgeschlagen');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border/60 rounded-xl shadow-dropdown p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-bold font-sans mb-1">Extraktion exportieren</h2>
        <p className="text-[10px] text-text-muted mb-4">
          Die Daten werden mit AES-256-GCM verschlüsselt. Bewahren Sie das Passwort sicher auf — ohne Passwort kein Zugriff.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] text-text-muted mb-1 font-mono">PASSWORT</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-bg border border-border rounded-md text-xs font-mono focus:outline-none focus:border-accent"
              placeholder="Mindestens 8 Zeichen"
              autoFocus
            />
            {password.length > 0 && (
              <div className={`text-[9px] mt-1 ${strengthColor}`}>
                Stärke: {strength}
              </div>
            )}
          </div>

          <div>
            <label className="block text-[10px] text-text-muted mb-1 font-mono">PASSWORT BESTÄTIGEN</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 bg-bg border border-border rounded-md text-xs font-mono focus:outline-none focus:border-accent"
              placeholder="Passwort wiederholen"
              onKeyDown={e => e.key === 'Enter' && handleExport()}
            />
          </div>

          {error && (
            <div className="text-[10px] text-ie-red bg-ie-red-bg border border-ie-red-border rounded-md p-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-3 py-2 border border-border rounded-md text-[10px] font-mono text-text-muted hover:border-border-light transition-colors"
            >
              ABBRECHEN
            </button>
            <button
              onClick={handleExport}
              disabled={loading || password.length < 8}
              className="flex-1 px-3 py-2 bg-accent text-white rounded-md text-[10px] font-mono hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'VERSCHLÜSSELN…' : 'EXPORTIEREN'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
