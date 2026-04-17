import { useState, useCallback } from 'react';
import { apiClient } from '../../api/client';
import { MergeSummary } from './MergeSummary';
import type { MergeDiff } from '../../types/extraction';

interface AddDocumentWizardProps {
  extractionId: number;
  onClose: () => void;
  onMerged: () => void; // callback to refresh extraction data
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  beschluss: 'Gerichtsbeschluss',
  insolvenzantrag: 'Insolvenzantrag',
  pzu: 'Postzustellungsurkunde (PZU)',
  handelsregister: 'Handelsregisterauszug',
  meldeauskunft: 'Meldeauskunft',
  fragebogen: 'Fragebogen / Selbstauskunft',
  grundbuch: 'Grundbuchauszug',
  gerichtsvollzieher: 'Gerichtsvollzieher-Auskunft',
  vollstreckungsportal: 'Vollstreckungsportal',
  forderungstabelle: 'Forderungsanmeldung',
  vermoegensverzeichnis: 'Vermögensverzeichnis',
  gutachterbestellung: 'Gutachterbestellung',
  sonstiges: 'Sonstiges Dokument',
};

const STEP_LABELS = ['Upload', 'Klassifizierung', 'Extraktion', 'Änderungen prüfen'];

export function AddDocumentWizard({ extractionId, onClose, onMerged }: AddDocumentWizardProps) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  // Upload result
  const [docId, setDocId] = useState<number | null>(null);
  const [sourceType, setSourceType] = useState('sonstiges');
  const [pageCount, setPageCount] = useState(0);
  const [warning, setWarning] = useState<string | null>(null);

  // Diff result
  const [diff, setDiff] = useState<MergeDiff | null>(null);

  const handleUpload = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      const { data } = await apiClient.post(`/extractions/${extractionId}/documents`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setDocId(data.docId);
      setSourceType(data.sourceType);
      setPageCount(data.pageCount);
      setWarning(data.warning);
      setStep(2);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr?.response?.data?.error || 'Upload fehlgeschlagen');
    } finally {
      setUploading(false);
    }
  }, [file, extractionId]);

  const handleExtract = useCallback(async () => {
    if (!docId) return;
    setExtracting(true);
    setError('');
    try {
      const { data } = await apiClient.post(
        `/extractions/${extractionId}/documents/${docId}/extract`,
        { sourceType }
      );
      setDiff(data as MergeDiff);
      setStep(4);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr?.response?.data?.error || 'Extraktion fehlgeschlagen');
    } finally {
      setExtracting(false);
    }
  }, [docId, extractionId, sourceType]);

  const handleApply = useCallback(async (acceptedPaths: string[], changes: Array<{ path: string; wert: unknown; quelle: string }>) => {
    if (!docId) return;
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
    } finally {
      setApplying(false);
    }
  }, [docId, extractionId, onMerged, onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-1 p-3 border-b border-border">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className="flex items-center gap-1">
              {i > 0 && <span className="text-border mx-1">&#x203A;</span>}
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                i + 1 === step ? 'bg-accent text-white font-bold' :
                i + 1 < step ? 'bg-accent/20 text-accent' : 'text-text-dim'
              }`}>{i + 1}</span>
              <span className={`text-[10px] ${i + 1 === step ? 'text-text font-semibold' : 'text-text-dim'}`}>
                {label}
              </span>
            </div>
          ))}
          <div className="flex-1" />
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {error && (
            <div className="mb-3 p-2 bg-red-900/20 border border-red-800/40 rounded text-[11px] text-red-300">{error}</div>
          )}

          {/* Step 1: Upload */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-[11px] text-text-muted">Zusätzliches Dokument hochladen (z.B. Grundbuchauszug, Meldeauskunft, Forderungsanmeldung)</p>
              <div
                onClick={() => document.getElementById('doc-upload-input')?.click()}
                className="border border-dashed border-border/90 rounded-lg py-10 px-6 text-center cursor-pointer hover:border-accent/30 hover:bg-accent/[0.04] transition-all"
              >
                {file ? (
                  <>
                    <div className="text-[12px] text-text font-medium truncate">{file.name}</div>
                    <div className="text-[10px] text-text-muted mt-1">{(file.size / 1024).toFixed(0)} KB</div>
                  </>
                ) : (
                  <div className="text-[12px] text-text-dim">PDF ablegen oder klicken</div>
                )}
              </div>
              <input
                id="doc-upload-input"
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={e => { if (e.target.files?.[0]) setFile(e.target.files[0]); }}
              />
            </div>
          )}

          {/* Step 2: Classification */}
          {step === 2 && (
            <div className="space-y-3">
              {warning && (
                <div className="p-2 bg-white border border-amber-600 rounded text-[11px] text-amber-900">
                  {warning}
                </div>
              )}
              <div>
                <label className="text-[10px] text-text-dim block mb-1">Dokumenttyp</label>
                <select
                  value={sourceType}
                  onChange={e => setSourceType(e.target.value)}
                  className="w-full px-2 py-2 bg-bg border border-border rounded text-[12px] text-text"
                >
                  {Object.entries(SOURCE_TYPE_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-bg border border-border/60 rounded px-3 py-2">
                  <div className="text-[9px] text-text-dim">Seiten</div>
                  <div className="text-[12px] text-text">{pageCount}</div>
                </div>
                <div className="bg-bg border border-border/60 rounded px-3 py-2">
                  <div className="text-[9px] text-text-dim">Datei</div>
                  <div className="text-[12px] text-text truncate">{file?.name}</div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Extracting */}
          {step === 3 && (
            <div className="text-center py-8">
              <div className="animate-spin w-6 h-6 border-2 border-accent border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-[11px] text-text-muted">Dokument wird analysiert...</p>
            </div>
          )}

          {/* Step 4: Merge Summary */}
          {step === 4 && diff && (
            <MergeSummary diff={diff} onApply={handleApply} onCancel={onClose} applying={applying} />
          )}
        </div>

        {/* Footer */}
        {step < 3 && (
          <div className="flex justify-between p-3 border-t border-border">
            <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
              className="px-4 py-1.5 text-[11px] text-text-muted hover:text-text disabled:opacity-30">
              Zurück
            </button>
            {step === 1 && (
              <button onClick={handleUpload} disabled={!file || uploading}
                className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
                {uploading ? 'Lädt hoch...' : 'Hochladen'}
              </button>
            )}
            {step === 2 && (
              <button onClick={() => { setStep(3); handleExtract(); }} disabled={extracting}
                className="px-4 py-1.5 bg-accent text-white rounded text-[11px] font-semibold disabled:opacity-50">
                Analysieren
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
