import { useEffect, useState, useCallback } from 'react';
import { apiClient } from '../../api/client';
import { MergeSummary } from './MergeSummary';
import type { MergeDiff } from '../../types/extraction';

interface ReviewMergeModalProps {
  extractionId: number;
  docId: number;
  onClose: () => void;
  onMerged: () => void;
}

interface JobState {
  status: 'idle' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string | null;
  error: string | null;
  diff: MergeDiff | null;
}

/**
 * Opens when the user clicks a completed supplement job in the navbar.
 * Loads the stored diff via GET /status and renders MergeSummary; the user
 * then applies scalar changes (array additions auto-merge via /apply).
 */
export function ReviewMergeModal({ extractionId, docId, onClose, onMerged }: ReviewMergeModalProps) {
  const [state, setState] = useState<JobState | null>(null);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiClient.get<JobState>(`/extractions/${extractionId}/documents/${docId}/status`)
      .then(({ data }) => { if (!cancelled) setState(data); })
      .catch((err: { response?: { data?: { error?: string } } }) => {
        if (!cancelled) setError(err?.response?.data?.error || 'Status konnte nicht geladen werden');
      });
    return () => { cancelled = true; };
  }, [extractionId, docId]);

  const handleApply = useCallback(async (acceptedPaths: string[], changes: Array<{ path: string; wert: unknown; quelle: string }>) => {
    setApplying(true);
    setError('');
    try {
      await apiClient.post(`/extractions/${extractionId}/documents/${docId}/apply`, {
        accept: acceptedPaths,
        changes,
      });
      onMerged();
      onClose();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr?.response?.data?.error || 'Merge fehlgeschlagen');
      setApplying(false);
    }
  }, [extractionId, docId, onMerged, onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <span className="text-[12px] font-semibold text-text font-sans">Dokument-Ergebnis prüfen</span>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">&times;</button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {error && <div className="mb-3 p-2 bg-red-900/20 border border-red-800/40 rounded text-[11px] text-red-300">{error}</div>}
          {!state && !error && (
            <div className="text-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-[11px] text-text-muted">Ergebnis wird geladen…</p>
            </div>
          )}
          {state && state.status === 'failed' && (
            <div className="text-center py-8">
              <p className="text-[12px] text-red-400 font-semibold mb-1">Analyse fehlgeschlagen</p>
              <p className="text-[11px] text-text-muted">{state.error}</p>
            </div>
          )}
          {state && (state.status === 'pending' || state.status === 'processing') && (
            <div className="text-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-[11px] text-text-muted">{state.message || 'Läuft…'} — {state.progress}%</p>
            </div>
          )}
          {state && state.status === 'completed' && state.diff && (
            <MergeSummary diff={state.diff} onApply={handleApply} onCancel={onClose} applying={applying} />
          )}
          {state && state.status === 'completed' && !state.diff && (
            <div className="text-center py-8">
              <p className="text-[11px] text-text-muted">Keine Ergebnisdaten vorhanden.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
