import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import Mark from 'mark.js';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { PdfContext } from '../../contexts/PdfContext';

// Worker von CDN – Version muss mit pdfjs-dist übereinstimmen (react-pdf nutzt 5.4.296)
pdfjs.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs';

// Only render pages near the viewport to avoid memory issues on large PDFs
const RENDER_BUFFER = 3; // pages above/below current page to render

interface PdfViewerProps {
  file: File;
  children: React.ReactNode;
}

/** Escape special regex chars so search string is treated as literal */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function PdfViewer({ file, children }: PdfViewerProps) {
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightRequest, setHighlightRequest] = useState<{ page: number; text: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Use Object URL instead of ArrayBuffer to avoid "detached ArrayBuffer" when PDF.js transfers to worker
  useEffect(() => {
    setLoadError(null);
    setTotalPages(0);
    setCurrentPage(1);
    pageRefs.current.clear();
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const fileProp = useMemo(
    () => (objectUrl ? { url: objectUrl } : null),
    [objectUrl]
  );

  // Observe container width for responsive PDF scaling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Create a single IntersectionObserver that lives as long as the container exists
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const page = Number(entry.target.getAttribute('data-page'));
            if (page) setCurrentPage(page);
          }
        }
      },
      { root, threshold: 0.5 }
    );
    observerRef.current = observer;
    return () => { observer.disconnect(); observerRef.current = null; };
  }, []);

  // Ref callback: observe/unobserve page elements as they mount/unmount
  const pageRefCallback = useCallback((page: number) => (el: HTMLDivElement | null) => {
    if (el) {
      pageRefs.current.set(page, el);
      observerRef.current?.observe(el);
    } else {
      const old = pageRefs.current.get(page);
      if (old) observerRef.current?.unobserve(old);
      pageRefs.current.delete(page);
    }
  }, []);

  const goToPage = useCallback((page: number) => {
    if (totalPages === 0) return;
    const clamped = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(clamped);
    setHighlightRequest(null);
    const el = pageRefs.current.get(clamped);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [totalPages]);

  const goToPageAndHighlight = useCallback((page: number, text?: string) => {
    if (totalPages === 0) return;
    const clamped = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(clamped);
    setHighlightRequest(text?.trim() ? { page: clamped, text: text.trim() } : null);
    const el = pageRefs.current.get(clamped);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [totalPages]);

  const clearHighlight = useCallback(() => {
    setHighlightRequest(null);
  }, []);

  const onDocLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setTotalPages(numPages);
  }, []);

  // Apply text highlight when we have a request and the target page is visible
  useEffect(() => {
    if (!highlightRequest?.text) return;
    const { page, text } = highlightRequest;
    const pageEl = pageRefs.current.get(page);
    if (!pageEl) return;

    const applyHighlight = () => {
      const textLayer = pageEl.querySelector('.textLayer') as HTMLElement | null;
      if (!textLayer) return false;
      const mark = new Mark(textLayer);
      mark.unmark({ className: 'source-highlight' });
      try {
        const escaped = escapeForRegex(text);
        mark.markRegExp(new RegExp(escaped, 'gi'), { className: 'source-highlight' });
      } catch {
        // Fallback for invalid regex (e.g. empty after escape)
        mark.mark(text, { className: 'source-highlight' });
      }
      return true;
    };

    const id = setTimeout(() => {
      if (!applyHighlight()) {
        setTimeout(applyHighlight, 400);
      }
    }, 500);
    return () => clearTimeout(id);
  }, [highlightRequest]);

  const ctx = useMemo(
    () => ({ goToPage, goToPageAndHighlight, currentPage, totalPages, highlightRequest, clearHighlight }),
    [goToPage, goToPageAndHighlight, currentPage, totalPages, highlightRequest, clearHighlight]
  );

  // Determine which pages to actually render (lazy rendering for memory)
  const visibleRange = useMemo(() => {
    const start = Math.max(1, currentPage - RENDER_BUFFER);
    const end = Math.min(totalPages, currentPage + RENDER_BUFFER);
    return { start, end };
  }, [currentPage, totalPages]);

  return (
    <PdfContext.Provider value={ctx}>
      <div className="flex h-[calc(100vh-56px)] gap-0 overflow-hidden">
        {/* PDF Panel */}
        <div className="w-[45%] min-w-[340px] flex flex-col bg-[#0d0f14] border-r border-border">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-border text-[10px] text-text-dim">
            <span className="truncate max-w-[200px]" title={file.name}>{file.name}</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || totalPages === 0}
                className="px-1.5 py-0.5 bg-surface-high border border-border rounded-sm hover:border-accent disabled:opacity-30 disabled:cursor-default transition-colors"
              >
                &larr;
              </button>
              <span className="text-text font-mono">
                {currentPage} / {totalPages || '?'}
              </span>
              <button
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages || totalPages === 0}
                className="px-1.5 py-0.5 bg-surface-high border border-border rounded-sm hover:border-accent disabled:opacity-30 disabled:cursor-default transition-colors"
              >
                &rarr;
              </button>
            </div>
          </div>

          {/* Scrollable PDF area */}
          <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
            {loadError ? (
              <div className="flex items-center justify-center h-full text-ie-red text-xs p-4">
                {loadError}
              </div>
            ) : !fileProp ? (
              <div className="flex items-center justify-center h-full text-text-muted text-xs">
                PDF wird geladen...
              </div>
            ) : (
              <Document
                file={fileProp}
                onLoadSuccess={onDocLoadSuccess}
                onLoadError={(err) => setLoadError(err?.message || 'PDF konnte nicht geladen werden')}
                loading={
                  <div className="flex items-center justify-center h-32 text-text-muted text-xs">
                    PDF wird gerendert...
                  </div>
                }
              >
                {Array.from({ length: totalPages }, (_, i) => {
                  const pageNum = i + 1;
                  const inRange = pageNum >= visibleRange.start && pageNum <= visibleRange.end;
                  return (
                    <div
                      key={pageNum}
                      data-page={pageNum}
                      ref={pageRefCallback(pageNum)}
                      className="mb-1 border-b border-border/30"
                      style={!inRange ? { height: '800px' } : undefined}
                    >
                      {inRange ? (
                        <Page
                          pageNumber={pageNum}
                          width={containerWidth ? containerWidth - 8 : undefined}
                          renderTextLayer={true}
                          renderAnnotationLayer={false}
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full text-text-muted text-[9px]">
                          Seite {pageNum}
                        </div>
                      )}
                      <div className="text-center text-[8px] text-text-muted py-0.5">
                        Seite {pageNum}
                      </div>
                    </div>
                  );
                })}
              </Document>
            )}
          </div>
        </div>

        {/* Results Panel */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[750px] mx-auto p-5 px-6">
            {children}
          </div>
        </div>
      </div>
    </PdfContext.Provider>
  );
}
