import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { apiClient } from '../api/client';

// ─── Types ───

interface DashboardStats {
  today: { extractions: number; completed: number; failed: number; activeUsers: number };
  week: { extractions: number; completed: number; failed: number; activeUsers: number };
  total: { extractions: number; users: number };
  avgProcessingTimeMs: number | null;
  recentFailures: Array<{
    id: number; filename: string; errorMessage: string | null;
    createdAt: string; username: string; displayName: string;
  }>;
}

interface AdminExtraction {
  id: number;
  filename: string;
  fileSize: number;
  status: string;
  errorMessage: string | null;
  statsFound: number | null;
  statsMissing: number | null;
  statsLettersReady: number | null;
  processingTimeMs: number | null;
  createdAt: string;
  username: string;
  displayName: string;
}

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  active: boolean;
  createdAt: string;
  extractionCount: number;
  lastLogin: string | null;
}

// ─── Helpers ───

function statusBadge(status: string) {
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
}

function formatTime(ms: number | null): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ─── Component ───

export function AdminPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [extractions, setExtractions] = useState<AdminExtraction[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [loading, setLoading] = useState(true);

  // Load dashboard + users on mount
  useEffect(() => {
    Promise.all([
      apiClient.get('/admin/dashboard'),
      apiClient.get('/admin/users'),
    ]).then(([dashRes, usersRes]) => {
      setStats(dashRes.data);
      setUsers(usersRes.data.users);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Load extractions on filter/page change
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    if (statusFilter) params.set('status', statusFilter);
    if (userFilter) params.set('user_id', userFilter);

    apiClient.get(`/admin/extractions?${params}`)
      .then(({ data }) => {
        setExtractions(data.extractions);
        setTotal(data.total);
        setTotalPages(data.totalPages);
      })
      .catch(() => {});
  }, [page, statusFilter, userFilter]);

  const labelClass = 'text-[9px] text-text-dim uppercase tracking-[2px] font-mono';
  const cardClass = 'bg-surface border border-border/60 rounded-lg p-4 shadow-card';

  if (loading) {
    return (
      <div className="min-h-screen bg-bg text-text font-mono">
        <Header />
        <div className="flex justify-center py-20">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin-fast" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <Header />
      <div className="max-w-[1200px] mx-auto p-5 px-6">
        {/* Title bar */}
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-bold font-sans">Admin</h1>
          <button
            onClick={() => navigate('/dashboard')}
            className="px-3 py-1.5 border border-border rounded-sm bg-transparent text-text-muted text-[10px] cursor-pointer font-mono hover:border-accent hover:text-accent transition-colors"
          >
            DASHBOARD
          </button>
        </div>

        {/* ─── Stats Cards ─── */}
        {stats && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            <div className={cardClass}>
              <div className={labelClass}>Heute</div>
              <div className="text-2xl font-bold mt-1">{stats.today.extractions}</div>
              <div className="text-[10px] text-text-muted mt-0.5">
                {stats.today.completed} fertig, {stats.today.failed > 0 ? (
                  <span className="text-ie-red font-bold">{stats.today.failed} fehlgeschlagen</span>
                ) : '0 Fehler'}
              </div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Fehler heute</div>
              <div className={`text-2xl font-bold mt-1 ${stats.today.failed > 0 ? 'text-ie-red' : 'text-ie-green'}`}>
                {stats.today.failed}
              </div>
              <div className="text-[10px] text-text-muted mt-0.5">
                Woche: {stats.week.failed}
              </div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Aktive Benutzer</div>
              <div className="text-2xl font-bold mt-1">{stats.today.activeUsers}</div>
              <div className="text-[10px] text-text-muted mt-0.5">
                Woche: {stats.week.activeUsers} &middot; Gesamt: {stats.total.users}
              </div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Avg. Dauer</div>
              <div className="text-2xl font-bold mt-1">{formatTime(stats.avgProcessingTimeMs)}</div>
              <div className="text-[10px] text-text-muted mt-0.5">
                Gesamt: {stats.total.extractions} Extraktionen
              </div>
            </div>
          </div>
        )}

        {/* ─── Recent Failures ─── */}
        {stats && stats.recentFailures.length > 0 && (
          <div className="mb-6">
            <div className={`${labelClass} mb-2`}>Letzte Fehler</div>
            <div className="bg-surface border border-ie-red-border/40 rounded-lg overflow-hidden">
              {stats.recentFailures.map(f => (
                <div key={f.id} className="flex items-center gap-3 px-4 py-2 border-b border-border/40 last:border-0 text-[11px]">
                  <span className="text-ie-red font-bold">#{f.id}</span>
                  <span className="truncate flex-1">{f.filename}</span>
                  <span className="text-text-muted">{f.displayName || f.username}</span>
                  <span className="text-text-dim text-[10px]">{formatDate(f.createdAt)}</span>
                  <span className="text-ie-red truncate max-w-[200px]">{f.errorMessage || '-'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Filters ─── */}
        <div className="flex items-center gap-3 mb-3">
          <div className={`${labelClass} mr-1`}>Extraktionen ({total})</div>
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
            className="bg-bg border border-border rounded-md text-[11px] px-2 py-1 font-mono text-text"
          >
            <option value="">Alle Status</option>
            <option value="completed">Fertig</option>
            <option value="failed">Fehler</option>
            <option value="processing">Läuft</option>
            <option value="expired">Abgelaufen</option>
          </select>
          <select
            value={userFilter}
            onChange={e => { setUserFilter(e.target.value); setPage(1); }}
            className="bg-bg border border-border rounded-md text-[11px] px-2 py-1 font-mono text-text"
          >
            <option value="">Alle Benutzer</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
            ))}
          </select>
        </div>

        {/* ─── Extractions Table ─── */}
        <div className="bg-surface border border-border/60 rounded-lg overflow-hidden shadow-card">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border/60 bg-bg/50">
                <th className="text-left px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Status</th>
                <th className="text-left px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Datei</th>
                <th className="text-left px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Benutzer</th>
                <th className="text-right px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Felder</th>
                <th className="text-right px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Dauer</th>
                <th className="text-right px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Datum</th>
              </tr>
            </thead>
            <tbody>
              {extractions.map(e => {
                const badge = statusBadge(e.status);
                return (
                  <tr
                    key={e.id}
                    onClick={() => e.status === 'completed' && navigate(`/dashboard?id=${e.id}`)}
                    className={`border-b border-border/30 hover:bg-bg/50 transition-colors ${e.status === 'completed' ? 'cursor-pointer' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold border ${badge.classes}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 truncate max-w-[250px]">{e.filename}</td>
                    <td className="px-3 py-2 text-text-muted">{e.displayName || e.username}</td>
                    <td className="px-3 py-2 text-right">
                      {e.statsFound != null ? (
                        <span>
                          <span className="text-ie-green">{e.statsFound}</span>
                          <span className="text-text-dim">/</span>
                          <span className="text-ie-red">{e.statsMissing}</span>
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-3 py-2 text-right text-text-muted">{formatTime(e.processingTimeMs)}</td>
                    <td className="px-3 py-2 text-right text-text-dim">{formatDate(e.createdAt)}</td>
                  </tr>
                );
              })}
              {extractions.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-text-muted">Keine Extraktionen gefunden</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ─── Pagination ─── */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-3">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className="px-2 py-1 border border-border rounded text-[10px] font-mono disabled:opacity-30 hover:border-accent transition-colors bg-transparent text-text cursor-pointer"
            >
              Zurück
            </button>
            <span className="text-[10px] text-text-muted">
              Seite {page} von {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-2 py-1 border border-border rounded text-[10px] font-mono disabled:opacity-30 hover:border-accent transition-colors bg-transparent text-text cursor-pointer"
            >
              Weiter
            </button>
          </div>
        )}

        {/* ─── Users Table ─── */}
        <div className={`${labelClass} mt-8 mb-2`}>Benutzer ({users.length})</div>
        <div className="bg-surface border border-border/60 rounded-lg overflow-hidden shadow-card mb-8">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border/60 bg-bg/50">
                <th className="text-left px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Name</th>
                <th className="text-left px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">E-Mail</th>
                <th className="text-right px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Extraktionen</th>
                <th className="text-right px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Letzter Login</th>
                <th className="text-right px-3 py-2 font-mono text-text-dim text-[9px] uppercase tracking-wider">Registriert</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b border-border/30">
                  <td className="px-3 py-2">
                    {u.displayName}
                    {u.role === 'admin' && (
                      <span className="ml-1.5 text-[8px] px-1 py-0.5 bg-accent/10 text-accent border border-accent/20 rounded">ADMIN</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-text-muted">{u.username}</td>
                  <td className="px-3 py-2 text-right">{u.extractionCount}</td>
                  <td className="px-3 py-2 text-right text-text-muted">{u.lastLogin ? formatDate(u.lastLogin) : '-'}</td>
                  <td className="px-3 py-2 text-right text-text-dim">{formatDate(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
