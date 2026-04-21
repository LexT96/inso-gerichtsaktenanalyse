import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { ExportDialog } from '../components/common/ExportDialog';
import { apiClient } from '../api/client';

type ExtractionStatus = 'processing' | 'completed' | 'failed' | 'expired' | 'deleted_art17';

interface HistoryItem {
  id: number;
  filename: string;
  fileSize: number;
  status: ExtractionStatus;
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
  createdAt: string;
}

export function HistoryPage() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportItem, setExportItem] = useState<HistoryItem | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    apiClient.get('/history')
      .then(({ data }) => setItems(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await apiClient.delete(`/history/${id}`);
      setItems(prev => prev.map(item =>
        item.id === id ? { ...item, status: 'deleted_art17' as ExtractionStatus } : item
      ));
    } catch {
      // ignore
    }
    setDeleteConfirm(null);
  }, []);

  const isActive = (status: ExtractionStatus) => status === 'completed';

  const statusBadge = (status: ExtractionStatus) => {
    switch (status) {
      case 'completed':
        return { label: 'FERTIG', classes: 'bg-ie-green-bg text-ie-green border-ie-green-border' };
      case 'failed':
        return { label: 'FEHLER', classes: 'bg-ie-red-bg text-ie-red border-ie-red-border' };
      case 'processing':
        return { label: 'LÄUFT', classes: 'bg-ie-amber-bg text-ie-amber border-ie-amber-border' };
      case 'expired':
        return { label: 'ABGELAUFEN', classes: 'bg-surface text-text-muted border-border' };
      case 'deleted_art17':
        return { label: 'GELÖSCHT', classes: 'bg-surface text-text-muted border-border' };
      default:
        return { label: status, classes: 'bg-surface text-text-muted border-border' };
    }
  };

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
          <div className="text-center py-10 text-text-muted text-xs">Laden...</div>
        ) : items.length === 0 ? (
          <div className="text-center py-10 text-text-muted text-xs">Noch keine Extraktionen durchgeführt.</div>
        ) : (
          <div className="space-y-2">
            {items.map(item => {
              const badge = statusBadge(item.status);
              const active = isActive(item.status);
              const isDeleted = item.status === 'deleted_art17';

              return (
                <div
                  key={item.id}
                  onClick={() => active && navigate(`/dashboard?id=${item.id}`)}
                  className={`bg-surface border border-border rounded-sm p-3 px-4 flex items-center gap-4 transition-colors
                    ${active ? 'cursor-pointer hover:border-border-light' : 'opacity-60 cursor-default'}
                    ${isDeleted ? 'line-through' : ''}`}
                >
                  <div className="flex-1">
                    <div className={`text-xs font-semibold font-sans ${isDeleted ? 'text-text-muted' : 'text-text'}`}>
                      {item.filename}
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      {new Date(item.createdAt.endsWith('Z') ? item.createdAt : item.createdAt + 'Z').toLocaleString('de-DE')} · {(item.fileSize / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                  {active && (
                    <div className="flex gap-3 text-[10px]">
                      <span className="text-ie-green">{item.statsFound} gefunden</span>
                      <span className="text-ie-red">{item.statsMissing} fehlend</span>
                      <span className="text-ie-blue">{item.statsLettersReady} Briefe</span>
                    </div>
                  )}
                  <span className={`text-[9px] px-2 py-0.5 rounded-sm font-bold border ${badge.classes}`}>
                    {badge.label}
                  </span>
                  {/* Action buttons */}
                  <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                    {active && (
                      <button
                        onClick={() => setExportItem(item)}
                        className="px-2 py-0.5 border border-border rounded-sm text-[9px] font-mono text-text-muted hover:border-accent hover:text-accent transition-colors"
                        title="Exportieren"
                      >
                        EXPORT
                      </button>
                    )}
                    {(active || item.status === 'expired') && (
                      <>
                        {deleteConfirm === item.id ? (
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleDelete(item.id)}
                              className="px-2 py-0.5 border border-ie-red-border rounded-sm text-[9px] font-mono text-ie-red bg-ie-red-bg hover:bg-ie-red hover:text-white transition-colors"
                            >
                              JA
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-2 py-0.5 border border-border rounded-sm text-[9px] font-mono text-text-muted hover:border-border-light transition-colors"
                            >
                              NEIN
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(item.id)}
                            className="px-2 py-0.5 border border-border rounded-sm text-[9px] font-mono text-text-muted hover:border-ie-red hover:text-ie-red transition-colors"
                            title="Löschen (Art. 17 DSGVO)"
                          >
                            ART.17
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {exportItem && (
        <ExportDialog
          extractionId={exportItem.id}
          filename={exportItem.filename}
          onClose={() => setExportItem(null)}
        />
      )}
    </div>
  );
}
