import { useState, useCallback, useMemo } from 'react';
import { Header } from '../components/layout/Header';
import { PdfUploader } from '../components/upload/PdfUploader';
import { TabNavigation } from '../components/extraction/TabNavigation';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { ErrorDisplay } from '../components/common/ErrorDisplay';
import { OverviewTab } from '../components/extraction/tabs/OverviewTab';
import { SchuldnerTab } from '../components/extraction/tabs/SchuldnerTab';
import { AntragstellerTab } from '../components/extraction/tabs/AntragstellerTab';
import { ForderungenTab } from '../components/extraction/tabs/ForderungenTab';
import { ErmittlungTab } from '../components/extraction/tabs/ErmittlungTab';
import { AnschreibenTab } from '../components/extraction/tabs/AnschreibenTab';
import { FehlendTab } from '../components/extraction/tabs/FehlendTab';
import { useExtraction } from '../hooks/useExtraction';
import type { ExtractionResult } from '../types/extraction';

function isFieldEmpty(field: { wert?: unknown; quelle?: unknown }): boolean {
  const w = field.wert;
  return w === null || w === undefined || w === '' || w === 0;
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
  const { loading, progress, result, error, extract, reset } = useExtraction();

  const handleAnalyze = useCallback(() => {
    if (file) extract(file);
  }, [file, extract]);

  const handleNewFile = useCallback(() => {
    reset();
    setFile(null);
    setTab('overview');
  }, [reset]);

  const stats = useMemo(() => result ? computeStats(result) : { found: 0, missing: 0, total: 0 }, [result]);

  const letters = result?.standardanschreiben || [];
  const bereit = letters.filter(l => l.status === 'bereit').length;
  const entfaellt = letters.filter(l => l.status === 'entfaellt').length;
  const fehlt = letters.filter(l => l.status === 'fehlt').length;
  const missingInfo = result?.fehlende_informationen || [];

  const tabs = useMemo(() => [
    { id: 'overview', label: 'Übersicht', icon: '◎' },
    { id: 'schuldner', label: 'Schuldner', icon: '●' },
    { id: 'antragsteller', label: 'Antragsteller', icon: '◆' },
    { id: 'forderungen', label: 'Forderungen', icon: '€' },
    { id: 'ermittlung', label: 'Ermittlung', icon: '◐' },
    { id: 'briefe', label: 'Anschreiben', icon: '✉', badge: bereit },
    { id: 'fehlend', label: 'Fehlend', icon: '△', badge: missingInfo.length },
  ], [bereit, missingInfo.length]);

  return (
    <div className="min-h-screen bg-bg text-text font-mono">
      <Header />

      <div className="max-w-[1050px] mx-auto p-5 px-6">
        {!result && (
          <PdfUploader
            file={file}
            onFileSelect={(f) => { setFile(f); }}
            onAnalyze={handleAnalyze}
            loading={loading}
          />
        )}

        {loading && progress && <LoadingSpinner message={progress} />}
        {error && <ErrorDisplay message={error} />}

        {result && (
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
            {tab === 'briefe' && <AnschreibenTab letters={letters} />}
            {tab === 'fehlend' && <FehlendTab missingInfo={missingInfo} />}

            {/* Footer */}
            <div className="mt-4 p-3 px-4 bg-surface border border-border rounded-sm text-[9px] text-text-muted leading-relaxed">
              <span className="text-text-dim font-bold">INSOLVENZ-EXTRAKTOR</span> · Alle extrahierten Daten
              müssen vor Verwendung manuell geprüft werden. § 43a BRAO, § 2 BORA, Art. 28 DSGVO.
              <span className="text-accent"> [Q]</span>-Buttons zeigen die Quellenreferenz für jeden Datenpunkt.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
