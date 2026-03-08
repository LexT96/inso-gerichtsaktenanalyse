import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { apiClient } from '../api/client';

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

export function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    apiClient.get('/history')
      .then(({ data }) => setItems(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <Header />
      <div className="max-w-[1050px] mx-auto p-5 px-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-bold font-sans">Verlauf</h1>
          <button
            onClick={() => navigate('/dashboard')}
            className="px-3 py-1.5 border border-border rounded-sm bg-transparent text-text-muted text-[10px] cursor-pointer font-mono hover:border-accent hover:text-accent transition-colors"
          >
            NEUE ANALYSE
          </button>
        </div>

        {loading ? (
          <div className="text-center py-10 text-text-muted text-xs">Laden…</div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 text-text-muted text-xs">Noch keine Extraktionen durchgeführt.</div>
        ) : (
          <div className="space-y-2">
            {items.map(item => (
              <div
                key={item.id}
                onClick={() => navigate(`/dashboard?id=${item.id}`)}
                className="bg-surface border border-border rounded-sm p-3 px-4 cursor-pointer hover:border-border-light transition-colors flex items-center gap-4"
              >
                <div className="flex-1">
                  <div className="text-xs font-semibold text-text font-sans">{item.filename}</div>
                  <div className="text-[10px] text-text-muted mt-0.5">
                    {new Date(item.createdAt).toLocaleString('de-DE')} · {(item.fileSize / 1024 / 1024).toFixed(2)} MB
                  </div>
                </div>
                <div className="flex gap-3 text-[10px]">
                  <span className="text-ie-green">{item.statsFound} gefunden</span>
                  <span className="text-ie-red">{item.statsMissing} fehlend</span>
                  <span className="text-ie-blue">{item.statsLettersReady} Briefe</span>
                </div>
                <span className={`text-[9px] px-2 py-0.5 rounded-sm font-bold border
                  ${item.status === 'completed' ? 'bg-ie-green-bg text-ie-green border-ie-green-border'
                    : item.status === 'failed' ? 'bg-ie-red-bg text-ie-red border-ie-red-border'
                    : 'bg-ie-amber-bg text-ie-amber border-ie-amber-border'}`}>
                  {item.status === 'completed' ? 'FERTIG' : item.status === 'failed' ? 'FEHLER' : 'LÄUFT'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
