import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client';

// ─── Types ───

interface LetterTemplateInfo {
  typ: string;
  filename: string | null;
  size: number | null;
  lastModified: string | null;
  hasBackup: boolean;
}

interface ErrorResponse {
  error?: string;
  missing?: string[];
}

// ─── Component ───

export function LetterTemplatesSection() {
  const [list, setList] = useState<LetterTemplateInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const cardClass = 'bg-surface border border-border/60 rounded-lg p-4 shadow-card';
  const labelClass = 'text-[9px] text-text-dim uppercase tracking-[2px] font-mono';
  const btnBase = 'px-3 py-1.5 border rounded-sm text-[10px] cursor-pointer font-mono transition-colors';
  const btnGhost = `${btnBase} bg-transparent border-border text-text-muted hover:border-accent hover:text-accent`;
  const btnPrimary = `${btnBase} bg-accent/10 border-accent/40 text-accent hover:bg-accent/20`;
  const btnDanger = `${btnBase} bg-transparent border-ie-red-border/40 text-ie-red hover:border-ie-red hover:bg-ie-red-bg transition-colors`;

  async function fetchList() {
    try {
      const res = await apiClient.get<LetterTemplateInfo[]>('/letter-templates');
      setList(res.data);
    } catch {
      setMessage({ text: 'Liste konnte nicht geladen werden.', isError: true });
    }
  }

  useEffect(() => {
    fetchList();
  }, []);

  async function download(typ: string) {
    try {
      const res = await apiClient.get(
        `/letter-templates/${encodeURIComponent(typ)}/download`,
        { responseType: 'blob' },
      );
      const entry = list.find((l) => l.typ === typ);
      const filename = entry?.filename?.split('/').pop() ?? `${typ}.docx`;
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setMessage({ text: 'Download fehlgeschlagen.', isError: true });
    }
  }

  async function upload(typ: string, file: File) {
    setBusy(typ);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('template', file);
      await apiClient.put(`/letter-templates/${encodeURIComponent(typ)}`, form);
      setMessage({ text: `${typ}: erfolgreich hochgeladen.`, isError: false });
      await fetchList();
    } catch (err) {
      const ax = err as { response?: { data?: ErrorResponse } };
      const d = ax?.response?.data;
      const missing = d?.missing?.length ? ` — fehlend: ${d.missing.join(', ')}` : '';
      setMessage({ text: `${d?.error ?? 'Upload fehlgeschlagen'}${missing}`, isError: true });
    } finally {
      setBusy(null);
    }
  }

  async function rollback(typ: string) {
    setBusy(typ);
    setMessage(null);
    try {
      await apiClient.post(`/letter-templates/${encodeURIComponent(typ)}/rollback`);
      setMessage({ text: `${typ}: zurückgerollt.`, isError: false });
      await fetchList();
    } catch (err) {
      const ax = err as { response?: { data?: ErrorResponse } };
      setMessage({ text: ax?.response?.data?.error ?? 'Rollback fehlgeschlagen.', isError: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className={cardClass}>
        <div className={`${labelClass} mb-3`}>Standardschreiben-Vorlagen</div>

        {/* Status message */}
        {message && (
          <div className={`text-[10px] font-mono mb-3 px-2 py-1.5 rounded border ${
            message.isError
              ? 'bg-ie-red-bg border-ie-red-border text-ie-red'
              : 'bg-ie-green-bg border-ie-green-border text-ie-green'
          }`}>
            {message.text}
          </div>
        )}

        {/* Table */}
        <div className="space-y-2">
          {list.length === 0 && (
            <div className="text-[11px] text-text-muted py-4 text-center font-mono">
              Keine Vorlagen gefunden
            </div>
          )}
          {list.map((l) => {
            const isBusy = busy === l.typ;
            return (
              <div
                key={l.typ}
                className="bg-bg/50 border border-border/40 rounded p-3 flex flex-col gap-2"
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] font-mono text-text">{l.typ}</span>
                    {l.filename ? (
                      <span className={`${labelClass} normal-case tracking-normal`}>
                        {l.filename.split('/').pop()}
                        {l.size != null && ` — ${(l.size / 1024).toFixed(0)} KB`}
                        {l.lastModified && ` — ${new Date(l.lastModified).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`}
                      </span>
                    ) : (
                      <span className={`${labelClass} normal-case tracking-normal text-text-dim`}>
                        Keine Datei gefunden
                      </span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => download(l.typ)}
                      disabled={isBusy || !l.filename}
                      className={`${btnGhost} disabled:opacity-40`}
                      title="Vorlage herunterladen"
                    >
                      Herunterladen
                    </button>

                    <label
                      className={`${btnPrimary} ${isBusy ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} inline-block`}
                      title="Neue Version hochladen"
                    >
                      {isBusy ? 'Lädt…' : 'Neue Version hochladen'}
                      <input
                        type="file"
                        accept=".docx"
                        className="hidden"
                        disabled={isBusy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) upload(l.typ, f);
                          e.target.value = '';
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      disabled={!l.hasBackup || isBusy}
                      onClick={() => rollback(l.typ)}
                      className={`${btnDanger} disabled:opacity-40`}
                      title="Auf vorherige Version zurücksetzen"
                    >
                      Zurücksetzen
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
