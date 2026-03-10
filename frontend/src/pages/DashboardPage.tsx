import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Header } from '../components/layout/Header';
import { PdfUploader } from '../components/upload/PdfUploader';
import { PdfViewer } from '../components/pdf/PdfViewer';
import { TabNavigation } from '../components/extraction/TabNavigation';
import { ExtractionProgressBar } from '../components/common/ExtractionProgressBar';
import { ErrorDisplay } from '../components/common/ErrorDisplay';
import { OverviewTab } from '../components/extraction/tabs/OverviewTab';
import { SchuldnerTab } from '../components/extraction/tabs/SchuldnerTab';
import { AntragstellerTab } from '../components/extraction/tabs/AntragstellerTab';
import { ForderungenTab } from '../components/extraction/tabs/ForderungenTab';
import { ErmittlungTab } from '../components/extraction/tabs/ErmittlungTab';
import { AnschreibenTab } from '../components/extraction/tabs/AnschreibenTab';
import { FehlendTab } from '../components/extraction/tabs/FehlendTab';
import { PrueflisteTab } from '../components/extraction/tabs/PrueflisteTab';
import { useExtraction } from '../hooks/useExtraction';
import { HistoryPanel } from '../components/dashboard/HistoryPanel';
import type { ExtractionResult } from '../types/extraction';

function isFieldEmpty(field: { wert?: unknown; quelle?: unknown }): boolean {
  const w = field.wert;
  return w === null || w === undefined || w === '';
}

function computeStats(result: ExtractionResult): { found: number; missing: number; total: number } {
  let found = 0, missing = 0;
  const walkObj = (obj: Record<string, unknown>): void => {
    if (!obj) return;
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) continue;
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if ('wert' in v || 'quelle' in v) {
          isFieldEmpty(v as { wert?: unknown; quelle?: unknown }) ? missing++ : found++;
        } else {
          walkObj(v as Record<string, unknown>);
        }
      }
    }
  };
  walkObj(result.verfahrensdaten as unknown as Record<string, unknown>);
  walkObj(result.schuldner as unknown as Record<string, unknown>);
  walkObj(result.antragsteller as unknown as Record<string, unknown>);
  walkObj(result.forderungen as unknown as Record<string, unknown>);
  walkObj(result.gutachterbestellung as unknown as Record<string, unknown>);
  return { found, missing, total: found + missing };
}

export function DashboardPage() {
  const [file, setFile] = useState<File | null>(null);
  const [tab, setTab] = useState('overview');
  const { loading, progress, progressPercent, result, error, extractionId, extract, reset, loadDemo, loadFromHistory, updateField } = useExtraction();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const historyId = searchParams.get('id');

  const handleHistorySelect = useCallback((id: number) => {
    navigate(`/dashboard?id=${id}`);
  }, [navigate]);

  const handleAnalyze = useCallback(() => {
    if (file) extract(file);
  }, [file, extract]);

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

  useEffect(() => {
    if (historyId && !loading) {
      const id = parseInt(historyId, 10);
      if (!isNaN(id) && (id !== extractionId || !result)) {
        loadFromHistory(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyId]);

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

  const tabs = useMemo(() => [
    { id: 'overview', label: 'Übersicht', icon: '\u25ce' },
    { id: 'schuldner', label: 'Schuldner', icon: '\u25cf' },
    { id: 'antragsteller', label: 'Antragsteller', icon: '\u25c6' },
    { id: 'forderungen', label: 'Forderungen', icon: '\u20ac' },
    { id: 'ermittlung', label: 'Ermittlung', icon: '\u25d0' },
    { id: 'pruefliste', label: 'Prüfliste', icon: '\u2713', badge: unconfirmedCount },
    { id: 'briefe', label: 'Anschreiben', icon: '\u2709', badge: bereit },
    { id: 'fehlend', label: 'Fehlend', icon: '\u25b3', badge: missingInfo.length },
  ], [bereit, missingInfo.length, unconfirmedCount]);

  // ─── Results content (used in both layouts) ───
  const resultsContent = result && (
    <div className="animate-fade-up-fast">
      <TabNavigation
        tabs={tabs}
        activeTab={tab}
        onTabChange={setTab}
        onNewFile={handleNewFile}
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
      {tab === 'schuldner' && <SchuldnerTab schuldner={result.schuldner} />}
      {tab === 'antragsteller' && <AntragstellerTab antragsteller={result.antragsteller} />}
      {tab === 'forderungen' && <ForderungenTab forderungen={result.forderungen} />}
      {tab === 'ermittlung' && (
        <ErmittlungTab
          ermittlungsergebnisse={result.ermittlungsergebnisse}
          gutachterbestellung={result.gutachterbestellung}
        />
      )}
      {tab === 'pruefliste' && (
        <PrueflisteTab result={result} onUpdateField={updateField} />
      )}
      {tab === 'briefe' && (
        <AnschreibenTab letters={letters} extractionId={extractionId ?? 0} />
      )}
      {tab === 'fehlend' && <FehlendTab missingInfo={missingInfo} />}

      {/* Footer */}
      <div className="mt-4 p-3 px-4 bg-surface border border-border rounded-sm text-[9px] text-text-muted leading-relaxed">
        <span className="text-text-dim font-bold">INSOLVENZ-EXTRAKTOR</span> · Alle extrahierten Daten
        müssen vor Verwendung manuell geprüft werden. § 43a BRAO, § 2 BORA, Art. 28 DSGVO.
        <span className="text-ie-blue"> [S.X]</span>-Buttons zeigen die Quellenreferenz und navigieren zur Seite im PDF.
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <Header />

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
      {result && file ? (
        <PdfViewer file={file}>
          {resultsContent}
        </PdfViewer>
      ) : result && !file ? (
        <div className="max-w-[1050px] mx-auto p-5 px-6">
          <div className="mb-3 p-2 px-3 bg-surface border border-border rounded-sm text-[10px] text-text-muted flex items-center gap-2">
            <span className="text-ie-amber">⚠</span>
            Verlaufs-Ansicht · PDF nicht verfügbar (wurde nach Extraktion gelöscht)
            <button
              onClick={handleNewFile}
              className="ml-auto px-2 py-0.5 border border-border rounded-sm hover:border-accent hover:text-accent transition-colors font-mono text-[10px]"
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
                <h1 className="text-lg font-bold text-text font-sans">Neue Akte analysieren</h1>
                <p className="text-[12px] text-text-muted mt-1 font-sans">
                  PDF hochladen → KI extrahiert Verfahrensdaten, Schuldner, Forderungen und erstellt Standardanschreiben mit Quellenreferenzen.
                </p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
                <PdfUploader
                file={file}
                onFileSelect={(f) => { setFile(f); }}
                onAnalyze={handleAnalyze}
                onDemo={handleDemo}
                loading={loading}
              />
              <HistoryPanel
                onSelect={handleHistorySelect}
                currentId={historyId ? parseInt(historyId, 10) : extractionId}
              />
              </div>
              <div className="mt-6 flex flex-wrap gap-6 text-[11px] text-text-muted font-sans">
                <span className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold">1</span>
                  PDF hochladen
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold">2</span>
                  KI analysiert Akte
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-full bg-accent/10 text-accent flex items-center justify-center text-[9px] font-bold">3</span>
                  Standardanschreiben & Quellen
                </span>
              </div>
            </>
          )}

          {loading && progress && (
            <ExtractionProgressBar progress={progressPercent} message={progress} />
          )}
          {error && <ErrorDisplay message={error} />}
        </div>
      )}
    </div>
  );
}
