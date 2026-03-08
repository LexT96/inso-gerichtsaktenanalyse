import { useCallback, useRef, type DragEvent, type ChangeEvent } from 'react';

interface PdfUploaderProps {
  file: File | null;
  onFileSelect: (file: File) => void;
  onAnalyze: () => void;
  loading: boolean;
}

export function PdfUploader({ file, onFileSelect, onAnalyze, loading }: PdfUploaderProps) {
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
      className={`border-2 border-dashed rounded-sm py-13 px-8 text-center cursor-pointer transition-all animate-fade-up
        ${file ? 'border-accent bg-surface-high' : 'border-border bg-surface hover:border-border-light'}`}
    >
      <input ref={fileRef} type="file" accept=".pdf" onChange={handleFile} className="hidden" />
      <div className="text-[40px] mb-3.5 opacity-50">{file ? '📄' : '📁'}</div>
      {file ? (
        <>
          <div className="text-sm font-semibold text-text font-sans">{file.name}</div>
          <div className="text-[11px] text-text-dim mt-1.5 mb-5">
            {(file.size / 1024 / 1024).toFixed(2)} MB
          </div>
          <button
            onClick={e => { e.stopPropagation(); onAnalyze(); }}
            disabled={loading}
            className={`px-7 py-2.5 rounded-sm border-none text-[11px] font-bold font-mono tracking-wide uppercase transition-colors
              ${loading
                ? 'bg-surface-high text-text-dim cursor-wait'
                : 'bg-accent text-bg cursor-pointer hover:brightness-110'
              }`}
          >
            {loading ? 'ANALYSIERE…' : 'AKTE ANALYSIEREN'}
          </button>
        </>
      ) : (
        <>
          <div className="text-[13px] text-text-dim font-sans">
            Gerichtsakte (PDF) ablegen oder klicken
          </div>
          <div className="text-[10px] text-text-muted mt-1.5">
            Max. 50 MB · PDF-Dateien
          </div>
        </>
      )}
    </div>
  );
}
