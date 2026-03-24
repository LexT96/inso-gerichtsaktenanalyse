import { useState, useRef } from 'react';
import { apiClient } from '../../api/client';
import type { ExtractionResult } from '../../types/extraction';

interface ImportDialogProps {
  onImport: (result: ExtractionResult, filename: string) => void;
  onClose: () => void;
}

export function ImportDialog({ onImport, onClose }: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      if (!selected.name.endsWith('.iae')) {
        setError('Nur .iae-Dateien werden akzeptiert');
        return;
      }
      setFile(selected);
      setError('');
    }
  };

  const handleImport = async () => {
    if (!file || !password) return;

    setLoading(true);
    setError('');

    try {
      const text = await file.text();
      const exportData = JSON.parse(text);

      const { data } = await apiClient.post('/history/import', { exportData, password });

      onImport(data.result, data.metadata?.filename || file.name.replace(/\.iae$/, '.pdf'));
      onClose();
    } catch (err) {
      const msg = err && typeof err === 'object' && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      setError(msg || 'Import fehlgeschlagen — falsches Passwort oder ungültige Datei?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-bold font-sans mb-1">Extraktion importieren</h2>
        <p className="text-[10px] text-text-muted mb-4">
          Wählen Sie eine .iae-Datei und geben Sie das Passwort ein, das beim Export verwendet wurde.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] text-text-muted mb-1 font-mono">DATEI (.iae)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".iae"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full px-3 py-2 bg-bg border border-border border-dashed rounded-sm text-xs font-mono text-text-muted hover:border-accent hover:text-accent transition-colors text-left"
            >
              {file ? file.name : 'Datei auswählen…'}
            </button>
          </div>

          <div>
            <label className="block text-[10px] text-text-muted mb-1 font-mono">PASSWORT</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-bg border border-border rounded-sm text-xs font-mono focus:outline-none focus:border-accent"
              placeholder="Export-Passwort eingeben"
              onKeyDown={e => e.key === 'Enter' && handleImport()}
            />
          </div>

          {error && (
            <div className="text-[10px] text-ie-red bg-ie-red-bg border border-ie-red-border rounded-sm p-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-3 py-2 border border-border rounded-sm text-[10px] font-mono text-text-muted hover:border-border-light transition-colors"
            >
              ABBRECHEN
            </button>
            <button
              onClick={handleImport}
              disabled={loading || !file || !password}
              className="flex-1 px-3 py-2 bg-accent text-white rounded-sm text-[10px] font-mono hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'ENTSCHLÜSSELN…' : 'IMPORTIEREN'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
