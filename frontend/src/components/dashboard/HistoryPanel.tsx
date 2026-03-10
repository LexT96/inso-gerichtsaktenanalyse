import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';

interface HistoryItem {
  id: number;
  filename: string;
  fileSize: number;
  status: 'processing' | 'completed' | 'failed';
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
  createdAt: string;
}

interface HistoryPanelProps {
  onSelect: (id: number) => void;
  currentId?: number | null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000) return d.toLocaleDateString('de-DE', { weekday: 'short' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

export function HistoryPanel({ onSelect, currentId }: HistoryPanelProps) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get('/history')
      .then(({ data }) => setItems(data.slice(0, 12)))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-surface-high">
        <h2 className="text-[11px] font-bold text-text-muted uppercase tracking-[1.5px] font-sans">
          Verlauf & Akten
        </h2>
      </div>
      <div className="max-h-[380px] min-h-[280px] overflow-y-auto">
        {loading ? (
          <div className="py-8 text-center text-[11px] text-text-muted">Laden…</div>
        ) : items.length === 0 ? (
          <div className="py-8 px-4 text-center text-[11px] text-text-muted">
            Noch keine Extraktionen.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`w-full text-left px-4 py-2.5 hover:bg-accent/[0.06] transition-colors
                  ${currentId === item.id ? 'bg-accent/10 border-l-2 border-l-accent' : ''}`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-text font-sans truncate">
                      {item.filename}
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-2">
                      <span>{formatDate(item.createdAt)}</span>
                      <span>·</span>
                      <span className="text-ie-green">{item.statsFound}</span>
                      <span className="text-ie-red">{item.statsMissing}</span>
                      <span className="text-ie-blue">{item.statsLettersReady} Briefe</span>
                    </div>
                  </div>
                  <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded font-bold
                    ${item.status === 'completed' ? 'bg-ie-green-bg text-ie-green'
                      : item.status === 'failed' ? 'bg-ie-red-bg text-ie-red'
                      : 'bg-ie-amber-bg text-ie-amber'}`}>
                    {item.status === 'completed' ? '✓' : item.status === 'failed' ? '!' : '…'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {items.length > 0 && (
        <Link
          to="/history"
          className="block px-4 py-2 border-t border-border text-[10px] text-text-muted hover:text-accent hover:bg-accent/[0.04] transition-colors text-center font-mono"
        >
          Alle anzeigen →
        </Link>
      )}
    </div>
  );
}
