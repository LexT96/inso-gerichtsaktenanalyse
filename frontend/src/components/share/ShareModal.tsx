import { useEffect, useState } from 'react';
import {
  listShares, grantShare, revokeShare, listShareCandidates,
  type ExtractionShare, type ShareCandidate,
} from '../../api/shares';

interface Props {
  extractionId: number;
  open: boolean;
  onClose: () => void;
}

export function ShareModal({ extractionId, open, onClose }: Props) {
  const [shares, setShares] = useState<ExtractionShare[]>([]);
  const [candidates, setCandidates] = useState<ShareCandidate[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    Promise.all([listShares(extractionId), listShareCandidates()])
      .then(([s, c]) => { setShares(s); setCandidates(c); })
      .catch(e => setError(e?.response?.data?.error ?? 'Laden fehlgeschlagen'));
  }, [open, extractionId]);

  if (!open) return null;

  const sharedIds = new Set(shares.map(s => s.userId));
  const filtered = candidates
    .filter(c => !sharedIds.has(c.userId))
    .filter(c => c.displayName.toLowerCase().includes(filter.toLowerCase()));

  async function handleGrant(userId: number) {
    setBusy(true); setError(null);
    try {
      const s = await grantShare(extractionId, userId);
      setShares(prev => [...prev, s]);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err?.response?.data?.error ?? 'Teilen fehlgeschlagen');
    } finally { setBusy(false); }
  }

  async function handleRevoke(userId: number) {
    setBusy(true); setError(null);
    try {
      await revokeShare(extractionId, userId);
      setShares(prev => prev.filter(s => s.userId !== userId));
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setError(err?.response?.data?.error ?? 'Entziehen fehlgeschlagen');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl p-6 w-[480px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-medium mb-4">Akte teilen</h2>

        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}

        <section className="mb-5">
          <h3 className="text-sm font-medium text-stone-700 mb-2">Aktuell geteilt mit</h3>
          {shares.length === 0 && <p className="text-sm text-stone-500">Noch niemand</p>}
          <ul className="space-y-1">
            {shares.map(s => (
              <li key={s.userId} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-stone-50">
                <span className="text-sm">{s.displayName}</span>
                <button
                  onClick={() => handleRevoke(s.userId)}
                  disabled={busy}
                  className="text-xs text-red-700 hover:text-red-900 disabled:opacity-50"
                  aria-label={`Zugriff für ${s.displayName} entziehen`}
                >Entziehen</button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="text-sm font-medium text-stone-700 mb-2">Teilen mit</h3>
          <input
            type="search"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Name suchen…"
            className="w-full mb-2 px-3 py-2 border border-stone-300 rounded-lg text-sm"
          />
          <ul className="max-h-48 overflow-y-auto space-y-1">
            {filtered.map(c => (
              <li key={c.userId} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-stone-50">
                <span className="text-sm">{c.displayName}</span>
                <button
                  onClick={() => handleGrant(c.userId)}
                  disabled={busy}
                  className="text-xs text-[#A52A2A] hover:underline disabled:opacity-50"
                >Teilen</button>
              </li>
            ))}
            {filtered.length === 0 && <li className="text-sm text-stone-500 px-2">Keine Treffer</li>}
          </ul>
        </section>

        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-stone-700 hover:text-stone-900">Schließen</button>
        </div>
      </div>
    </div>
  );
}
