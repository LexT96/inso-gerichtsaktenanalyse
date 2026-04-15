import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { PdfUploader } from '../components/upload/PdfUploader';
import { PdfViewer } from '../components/pdf/PdfViewer';
import { TabNavigation } from '../components/extraction/TabNavigation';
import { ExtractionProgressBar } from '../components/common/ExtractionProgressBar';
import { ErrorDisplay } from '../components/common/ErrorDisplay';
import { ExportDialog } from '../components/common/ExportDialog';
import { ImportDialog } from '../components/common/ImportDialog';
import { OverviewTab } from '../components/extraction/tabs/OverviewTab';
import { QuellenTab } from '../components/extraction/tabs/QuellenTab';
import { BeteiligteTab } from '../components/extraction/tabs/BeteiligteTab';
import { ForderungenTab } from '../components/extraction/tabs/ForderungenTab';
import { ErmittlungTab } from '../components/extraction/tabs/ErmittlungTab';
import { PrueflisteTab } from '../components/extraction/tabs/PrueflisteTab';
import { AnschreibenTab } from '../components/extraction/tabs/AnschreibenTab';
import { AktivaTab } from '../components/extraction/tabs/AktivaTab';
import { AnfechtungTab } from '../components/extraction/tabs/AnfechtungTab';
import { GutachtenTab } from '../components/extraction/tabs/GutachtenTab';
import { AddDocumentWizard } from '../components/extraction/AddDocumentWizard';
import { apiClient } from '../api/client';
import { useExtraction } from '../hooks/useExtraction';
import { ExtractionProvider } from '../contexts/ExtractionContext';
import { HistoryPanel } from '../components/dashboard/HistoryPanel';
import type { ExtractionResult } from '../types/extraction';
// Shared stats computation — single source of truth with backend
import { computeExtractionStats, type FieldDetail } from '@shared/utils/computeStats';
export type { FieldDetail };

function computeStats(result: ExtractionResult) {
  return computeExtractionStats(result);
}


export function DashboardPage() {
  const [file, setFile] = useState<File | null>(null);
  const [tab, setTab] = useState('overview');
  const [proMode, setProMode] = useState(false);
  const { loading, progress, progressPercent, result, error, extractionId, pdfFile, extract, reset, loadDemo, loadFromHistory, loadFromImport, updateField, resumeIfProcessing } = useExtraction();
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [importedFilename, setImportedFilename] = useState<string | null>(null);
  const [extraDocs, setExtraDocs] = useState<Array<{ file: File; label: string }>>([]);
  const [docRefreshKey, setDocRefreshKey] = useState(0);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const historyId = searchParams.get('id');

  const handleHistorySelect = useCallback((id: number) => {
    navigate(`/dashboard?id=${id}`);
  }, [navigate]);

  const handleAnalyze = useCallback(() => {
    if (file) extract(file, proMode);
  }, [file, extract, proMode]);

  const handleDemo = useCallback(async () => {
    const demoFile = await loadDemo();
    if (demoFile) setFile(demoFile);
  }, [loadDemo]);

  const handleNewFile = useCallback(() => {
    reset();
    setFile(null);
    setTab('overview');
    navigate('/dashboard');
  }, [reset, navigate]);

  // On mount: check if an extraction is still processing (e.g. after tab refresh)
  useEffect(() => {
    if (!historyId && !result && !loading) {
      resumeIfProcessing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (historyId && !loading) {
      const id = parseInt(historyId, 10);
      if (!isNaN(id) && (id !== extractionId || !result)) {
        loadFromHistory(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId]);

  // Load supplementary documents for the PDF viewer
  useEffect(() => {
    if (!extractionId) { setExtraDocs([]); return; }
    (async () => {
      try {
        const { data: docs } = await apiClient.get(`/extractions/${extractionId}/documents`);
        const supplementDocs = (docs as Array<{ id: number; doc_index: number; source_type: string; original_filename: string }>)
          .filter(d => d.doc_index > 0);
        if (supplementDocs.length === 0) { setExtraDocs([]); return; }
        const loaded: Array<{ file: File; label: string }> = [];
        for (const doc of supplementDocs) {
          try {
            const res = await apiClient.get(`/extractions/${extractionId}/documents/${doc.id}/pdf`, { responseType: 'blob' });
            loaded.push({
              file: new File([res.data], doc.original_filename, { type: 'application/pdf' }),
              label: `${doc.source_type} — ${doc.original_filename}`,
            });
          } catch { /* skip */ }
        }
        setExtraDocs(loaded);
      } catch { setExtraDocs([]); }
    })();
  }, [extractionId, docRefreshKey]);

  const stats = useMemo(() => result ? computeStats(result) : { found: 0, missing: 0, total: 0 }, [result]);

  const letters = result?.standardanschreiben || [];
  const bereit = letters.filter(l => l.status === 'bereit').length;
  const entfaellt = letters.filter(l => l.status === 'entfaellt').length;
  const fehlt = letters.filter(l => l.status === 'fehlt').length;
  const missingInfo = result?.fehlende_informationen || [];

  const unconfirmedCount = useMemo(() => {
    if (!result) return 0;
    const paths = [
      'verfahrensdaten.aktenzeichen', 'verfahrensdaten.gericht',
      'schuldner.name', 'schuldner.vorname', 'schuldner.geburtsdatum',
      'schuldner.aktuelle_adresse', 'schuldner.handelsregisternummer',
      'schuldner.firma', 'schuldner.betriebsstaette_adresse',
    ];
    let count = 0;
    for (const p of paths) {
      const parts = p.split('.');
      let obj: unknown = result;
      for (const part of parts) {
        if (obj == null || typeof obj !== 'object') { obj = null; break; }
        obj = (obj as Record<string, unknown>)[part];
      }
      if (obj && typeof obj === 'object' && 'wert' in (obj as object)) {
        const field = obj as { wert: unknown; pruefstatus?: string };
        const hasVal = field.wert !== null && field.wert !== undefined && String(field.wert).trim() !== '';
        if (hasVal && !field.pruefstatus) count++;
      }
    }
    return count;
  }, [result]);

  const anschreibenBadge = missingInfo.length > 0 ? missingInfo.length : bereit > 0 ? bereit : undefined;

  const groups = useMemo(() => [
    { id: 'akte', label: 'Akte' },
    { id: 'finanzen', label: 'Finanzen' },
    { id: 'analyse', label: 'Analyse' },
    { id: 'ausgabe', label: 'Ausgabe' },
  ], []);

  const tabs = useMemo(() => [
    { id: 'overview', label: 'Übersicht', icon: '◎', group: 'akte' },
    { id: 'beteiligte', label: 'Beteiligte', icon: '●', group: 'akte' },
    { id: 'quellen', label: 'Quellen', icon: '□', group: 'akte' },
    { id: 'forderungen', label: 'Forderungen', icon: '€', group: 'finanzen' },
    { id: 'aktiva', label: 'Aktiva', icon: '▣', group: 'finanzen' },
    { id: 'anfechtung', label: 'Anfechtung', icon: '⚡', group: 'finanzen' },
    { id: 'ermittlung', label: 'Ermittlung', icon: '◐', group: 'analyse' },
    { id: 'pruefliste', label: 'Prüfliste', icon: '✓', badge: unconfirmedCount, group: 'analyse' },
    { id: 'briefe', label: 'Anschreiben', icon: '✉', badge: anschreibenBadge, group: 'ausgabe' },
    { id: 'gutachten', label: 'Gutachten', icon: '◇', group: 'ausgabe' },
  ], [anschreibenBadge, unconfirmedCount]);

  // Compute group progress from extraction stats
  const groupProgress = useMemo(() => {
    if (!result) return {} as Record<string, 'complete' | 'partial' | 'empty'>;
    const hasVal = (field: unknown): boolean => {
      if (!field || typeof field !== 'object') return false;
      const f = field as { wert?: unknown };
      return f.wert !== null && f.wert !== undefined && String(f.wert).trim() !== '';
    };
    const v = result.verfahrensdaten;
    const s = result.schuldner;
    const akteFields = [v?.aktenzeichen, v?.gericht, s?.name, s?.firma].filter(hasVal).length;
    const forderungenCount = result.forderungen?.einzelforderungen?.length || 0;
    const aktivaCount = result.aktiva?.positionen?.length || 0;
    const ermittlungFields = [
      result.ermittlungsergebnisse?.grundbuch?.ergebnis,
      result.ermittlungsergebnisse?.gerichtsvollzieher?.vollstreckungen,
    ].filter(hasVal).length;
    return {
      akte: akteFields >= 3 ? 'complete' as const : akteFields > 0 ? 'partial' as const : 'empty' as const,
      finanzen: (forderungenCount > 0 && aktivaCount > 0) ? 'complete' as const : (forderungenCount > 0 || aktivaCount > 0) ? 'partial' as const : 'empty' as const,
      analyse: ermittlungFields > 0 ? 'partial' as const : 'empty' as const,
      ausgabe: bereit > 0 ? 'partial' as const : 'empty' as const,
    };
  }, [result, bereit]);

  // ─── Results content (used in both layouts) ───
  const resultsContent = result && (
    <ExtractionProvider value={{ extractionId }}>
    <div className="animate-fade-up-fast">
      <TabNavigation
        tabs={tabs}
        groups={groups}
        activeTab={tab}
        onTabChange={setTab}
        onAddDocument={extractionId ? () => setShowAddDoc(true) : undefined}
        groupProgress={groupProgress}
      />

      {tab === 'overview' && (
        <OverviewTab
          result={result}
          stats={stats}
          lettersReady={bereit}
          lettersNA={entfaellt}
          lettersOpen={fehlt}
        />
      )}
      {tab === 'quellen' && <QuellenTab result={result} />}
      {tab === 'beteiligte' && <BeteiligteTab schuldner={result.schuldner} antragsteller={result.antragsteller} />}
      {tab === 'forderungen' && <ForderungenTab forderungen={result.forderungen} />}
      {tab === 'aktiva' && (
        <AktivaTab aktiva={result.aktiva} forderungen={result.forderungen} schuldner={result.schuldner} />
      )}
      {tab === 'anfechtung' && (
        <AnfechtungTab anfechtung={result.anfechtung} verfahrensdaten={result.verfahrensdaten} />
      )}
      {tab === 'ermittlung' && (
        <ErmittlungTab
          ermittlungsergebnisse={result.ermittlungsergebnisse}
          gutachterbestellung={result.gutachterbestellung}
          letters={letters}
          missingInfo={missingInfo}
        />
      )}
      {tab === 'pruefliste' && (
        <PrueflisteTab result={result} onUpdateField={updateField} />
      )}
      {tab === 'briefe' && (
        <AnschreibenTab result={result} letters={letters} missingInfo={missingInfo} onUpdateField={updateField} />
      )}
      {tab === 'gutachten' && (
        <GutachtenTab result={result} extractionId={extractionId} onUpdateField={updateField} />
      )}

      {/* Footer */}
      <div className="mt-4 p-3 px-4 bg-surface border border-border/40 rounded-lg text-[8px] text-text-muted leading-relaxed font-mono">
        <span className="text-accent font-bold tracking-[1.5px]">TBS</span>
        <span className="text-text-dim tracking-wide"> AKTENANALYSE</span>
        <span className="mx-1.5 text-border">|</span>
        Alle extrahierten Daten müssen vor Verwendung manuell geprüft werden.
        <span className="text-ie-blue"> [S.X]</span>-Buttons zeigen die Quellenreferenz und navigieren zur Seite im PDF.
      </div>
    </div>
    </ExtractionProvider>
  );

  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <Header
        onExport={extractionId ? () => setShowExport(true) : undefined}
        onNewFile={result ? handleNewFile : undefined}
      />

      {/* Subtle grid background on upload view */}
      {!result && (
        <div
          className="fixed inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(0deg, #D1D5DB 0px, transparent 1px, transparent 24px),
              repeating-linear-gradient(90deg, #D1D5DB 0px, transparent 1px, transparent 24px)`,
          }}
        />
      )}

      {/* Split layout when results are available + file exists */}
      {result && (file || pdfFile) ? (
        <PdfViewer file={(file || pdfFile)!} documents={extraDocs.length > 0 ? extraDocs : undefined}>
          {resultsContent}
        </PdfViewer>
      ) : result && !file && !pdfFile ? (
        <div className="max-w-[1050px] mx-auto p-5 px-6">
          <div className="mb-3 p-2 px-3 bg-surface border border-border/60 rounded-lg text-[10px] text-text-muted flex items-center gap-2">
            <span className="text-ie-amber">⚠</span>
            {importedFilename ? `Import: ${importedFilename}` : 'Verlaufs-Ansicht · PDF nicht verfügbar (wurde nach Extraktion gelöscht)'}
            {extractionId && (
              <>
                <button
                  onClick={() => setShowExport(true)}
                  className="px-2 py-0.5 border border-border rounded-md hover:border-accent hover:text-accent transition-colors font-mono text-[10px]"
                >
                  EXPORTIEREN
                </button>
                <button
                  onClick={() => setShowAddDoc(true)}
                  className="px-2 py-0.5 border border-border rounded-md hover:border-accent hover:text-accent transition-colors font-mono text-[10px]"
                >
                  + DOKUMENT
                </button>
              </>
            )}
            <button
              onClick={handleNewFile}
              className="ml-auto px-2 py-0.5 border border-border rounded-md hover:border-accent hover:text-accent transition-colors font-mono text-[10px]"
            >
              NEUE ANALYSE
            </button>
          </div>
          {resultsContent}
        </div>
      ) : (
        <div className="max-w-[1050px] mx-auto p-6 px-6 relative">
          {!result && (
            <>
              <div className="mb-6">
                <h1 className="text-lg font-bold text-text font-sans tracking-tight">Neue Akte analysieren</h1>
                <p className="text-[12px] text-text-muted mt-1.5 font-sans leading-relaxed">
                  PDF hochladen — KI extrahiert Verfahrensdaten, Schuldner, Forderungen und erstellt Standardanschreiben mit Quellenreferenzen.
                </p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
                <PdfUploader
                file={file}
                onFileSelect={(f) => { setFile(f); }}
                onAnalyze={handleAnalyze}
                onDemo={handleDemo}
                loading={loading}
                proMode={proMode}
                onProModeChange={setProMode}
              />
              <HistoryPanel
                onSelect={handleHistorySelect}
                currentId={historyId ? parseInt(historyId, 10) : extractionId}
              />
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-5 text-[11px] text-text-muted font-sans">
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold font-mono">1</span>
                  PDF hochladen
                </span>
                <span className="text-border">—</span>
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold font-mono">2</span>
                  KI analysiert Akte
                </span>
                <span className="text-border">—</span>
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold font-mono">3</span>
                  Anschreiben & Quellen
                </span>
                <button
                  onClick={() => setShowImport(true)}
                  className="ml-auto px-3 py-1.5 border border-border rounded-md text-[10px] font-mono text-text-muted hover:border-accent hover:text-accent transition-colors"
                >
                  .iae IMPORTIEREN
                </button>
              </div>
            </>
          )}

          {loading && progress && (
            <ExtractionProgressBar progress={progressPercent} message={progress} />
          )}
          {error && <ErrorDisplay message={error} />}
        </div>
      )}

      {showExport && extractionId && (
        <ExportDialog
          extractionId={extractionId}
          filename={file?.name || importedFilename || 'extraktion'}
          onClose={() => setShowExport(false)}
        />
      )}

      {showImport && (
        <ImportDialog
          onImport={(importedResult, fname) => {
            loadFromImport(importedResult);
            setImportedFilename(fname);
            setFile(null);
            navigate('/dashboard');
          }}
          onClose={() => setShowImport(false)}
        />
      )}

      {showAddDoc && extractionId && (
        <AddDocumentWizard
          extractionId={extractionId}
          onClose={() => setShowAddDoc(false)}
          onMerged={() => {
            if (extractionId) loadFromHistory(extractionId);
            setDocRefreshKey(k => k + 1);
            setShowAddDoc(false);
          }}
        />
      )}
    </div>
  );
}
