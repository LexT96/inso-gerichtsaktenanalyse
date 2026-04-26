import { useCallback, useRef, type DragEvent, type ChangeEvent } from 'react';

interface PdfUploaderProps {
  file: File | null;
  onFileSelect: (file: File) => void;
  onAnalyze: () => void;
  onDemo?: () => void;
  loading: boolean;
  proMode: boolean;
  onProModeChange: (enabled: boolean) => void;
  isAdmin?: boolean;
}

export function PdfUploader({ file, onFileSelect, onAnalyze, onDemo, loading, proMode, onProModeChange, isAdmin }: PdfUploaderProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((e: DragEvent<HTMLDivElement> | ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    const f = 'dataTransfer' in e
      ? e.dataTransfer?.files?.[0]
      : (e.target as HTMLInputElement)?.files?.[0];
    if (f?.type === 'application/pdf') {
      onFileSelect(f);
    }
  }, [onFileSelect]);

  return (
    <div
      onDrop={handleFile}
      onDragOver={e => e.preventDefault()}
      onClick={() => fileRef.current?.click()}
      className={`border border-dashed rounded-lg py-14 px-8 text-center cursor-pointer transition-all duration-200 animate-fade-up min-h-[220px] flex flex-col items-center justify-center
        ${file
          ? 'border-accent/60 bg-accent/5'
          : 'border-border/90 bg-accent/[0.04] hover:border-accent/30 hover:bg-accent/[0.07]'}`}
    >
      <input ref={fileRef} type="file" accept=".pdf" onChange={handleFile} className="hidden" />
      <div className="text-[36px] mb-4 opacity-60 select-none">{file ? '📄' : '📁'}</div>
      {file ? (
        <>
          <div className="text-sm font-medium text-text font-sans truncate max-w-[280px] mx-auto">
            {file.name}
          </div>
          <div className="text-[11px] text-text-muted mt-1 mb-4">
            {(file.size / 1024 / 1024).toFixed(2)} MB
          </div>
          <button
            onClick={e => { e.stopPropagation(); onAnalyze(); }}
            disabled={loading}
            className={`px-6 py-2 rounded-md border-none text-[11px] font-semibold font-mono tracking-wide uppercase transition-all duration-200
              ${loading
                ? 'bg-surface-high text-text-dim cursor-wait'
                : 'bg-accent text-white cursor-pointer hover:brightness-110 active:scale-[0.98]'
              }`}
          >
            {loading ? 'ANALYSIERE…' : 'AKTE ANALYSIEREN'}
          </button>
          {/* Pro mode: Opus 4.6 — nur für Admins */}
          {isAdmin && (
            <div className="mt-3 flex items-center justify-center gap-2" onClick={e => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => onProModeChange(!proMode)}
                disabled={loading}
                className={`relative w-8 h-[18px] rounded-full transition-colors duration-200 ${proMode ? 'bg-accent' : 'bg-border'} disabled:opacity-50`}
                aria-label="Pro-Mode umschalten"
              >
                <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-200 ${proMode ? 'left-[16px]' : 'left-[2px]'}`} />
              </button>
              <span className={`text-[10px] font-mono ${proMode ? 'text-accent font-semibold' : 'text-text-muted'}`}>
                PRO
              </span>
              <span className="text-[9px] text-text-muted font-mono">
                {proMode ? 'Opus 4.6 · präziser · ~3–5 Min' : 'Admin-Test'}
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="text-[13px] text-text-dim font-sans font-medium">
            Gerichtsakte (PDF) ablegen oder klicken
          </div>
          <div className="text-[11px] text-text-muted mt-1.5 tracking-wide">
            Max. 50 MB · PDF-Dateien
          </div>
          {onDemo && isAdmin && (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_FLOW === '1') && (
            <button
              onClick={(e) => { e.stopPropagation(); onDemo(); }}
              disabled={loading}
              className="mt-5 px-5 py-2 rounded-md border border-ie-blue-border/80 text-ie-blue text-[11px] font-medium font-sans hover:bg-ie-blue/5 hover:border-ie-blue-border transition-all duration-200 disabled:opacity-50 active:scale-[0.98]"
            >
              Demo starten (PDF + Quellen testen)
            </button>
          )}
        </>
      )}
    </div>
  );
}
