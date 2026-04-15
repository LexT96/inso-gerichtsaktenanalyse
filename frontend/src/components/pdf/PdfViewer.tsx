import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import Mark from 'mark.js';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { PdfContext } from '../../contexts/PdfContext';

// Worker von CDN – Version muss mit pdfjs-dist übereinstimmen (react-pdf nutzt 5.4.296)
pdfjs.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@5.4.296/build/pdf.worker.min.mjs';

// WASM modules for JPEG2000 (scanned PDFs) — served from /wasm/ in public/
const PDFJS_OPTIONS = {
  wasmUrl: (import.meta.env.BASE_URL || '/').replace(/\/$/, '') + '/wasm/',
};

// Only render pages near the viewport to avoid memory issues on large PDFs
const RENDER_BUFFER = 3; // pages above/below current page to render

interface DocFile {
  file: File;
  label: string;
}

interface PdfViewerProps {
  file: File;
  /** Additional documents to show in dropdown */
  documents?: DocFile[];
  children: React.ReactNode;
}

/** Escape special regex chars so search string is treated as literal */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const DEFAULT_ASPECT = 595 / 842; // A4 fallback

export function PdfViewer({ file, documents, children }: PdfViewerProps) {
  // Build full document list: primary file + any additional documents
  const allDocs = useMemo(() => {
    const docs: DocFile[] = [{ file, label: file.name }];
    if (documents) docs.push(...documents);
    return docs;
  }, [file, documents]);

  // -1 = show all concatenated, 0+ = individual document
  const [activeDocIndex, setActiveDocIndex] = useState(0);
  const showAll = activeDocIndex === -1;
  const activeFile = showAll ? allDocs[0].file : (allDocs[activeDocIndex]?.file ?? file);

  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightRequest, setHighlightRequest] = useState<{ page: number; text: string; quelle?: string } | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [pageAspectRatio, setPageAspectRatio] = useState(DEFAULT_ASPECT);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const scrollingToRef = useRef<number | null>(null); // suppress observer during programmatic scroll
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use Object URL instead of ArrayBuffer to avoid "detached ArrayBuffer" when PDF.js transfers to worker
  useEffect(() => {
    setLoadError(null);
    setTotalPages(0);
    setCurrentPage(1);
    pageRefs.current.clear();
    const url = URL.createObjectURL(activeFile);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [activeFile]);

  const fileProp = useMemo(
    () => (objectUrl ? { url: objectUrl } : null),
    [objectUrl]
  );

  // Observe container dimensions for responsive PDF scaling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
      setContainerHeight(entry.contentRect.height);
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
        if (scrollingToRef.current !== null) return; // suppress during programmatic scroll
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

  /** Scroll to target page, retrying until layout stabilises.
   *  When jumping many pages, placeholder→rendered height changes cause layout shifts.
   *  We use instant scrolls + rAF retries to converge on the correct position. */
  const scrollToPageStable = useCallback((targetPage: number, opts?: { block?: ScrollLogicalPosition }) => {
    const block = opts?.block ?? 'center';
    scrollingToRef.current = targetPage;
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);

    let rafId: number | null = null;
    let lastTop = -1;
    let stableCount = 0;
    const MAX_RETRIES = 20;
    let retries = 0;

    const settle = () => {
      retries++;
      const el = pageRefs.current.get(targetPage);
      if (!el || retries > MAX_RETRIES) {
        scrollingToRef.current = null;
        return;
      }

      el.scrollIntoView({ behavior: 'instant', block });

      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - lastTop) < 2) {
        stableCount++;
      } else {
        stableCount = 0;
      }
      lastTop = top;

      if (stableCount >= 3) {
        scrollingToRef.current = null;
        return;
      }

      rafId = requestAnimationFrame(settle);
    };

    rafId = requestAnimationFrame(settle);

    const prevTimer = scrollTimerRef.current;
    scrollTimerRef.current = setTimeout(() => {
      if (rafId) cancelAnimationFrame(rafId);
      scrollingToRef.current = null;
    }, 3000);
    if (prevTimer) clearTimeout(prevTimer);
  }, []);

  const goToPage = useCallback((page: number) => {
    if (totalPages === 0) return;
    const clamped = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(clamped);
    setHighlightRequest(null);
    scrollToPageStable(clamped);
  }, [totalPages, scrollToPageStable]);

  const goToPageAndHighlight = useCallback((page: number, text?: string, quelle?: string) => {
    if (totalPages === 0) return;
    const clamped = Math.max(1, Math.min(page, totalPages));
    const trimmed = text?.trim();
    setCurrentPage(clamped);
    setHighlightRequest(trimmed ? { page: clamped, text: trimmed, quelle } : null);
    scrollToPageStable(clamped, trimmed ? { block: 'start' } : undefined);
  }, [totalPages, scrollToPageStable]);

  const clearHighlight = useCallback(() => {
    setHighlightRequest(null);
  }, []);

  const onDocLoadSuccess = useCallback((pdf: { numPages: number; getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number } }> }) => {
    setTotalPages(pdf.numPages);
    pdf.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1 });
      setPageAspectRatio(vp.width / vp.height);
    }).catch(() => {});
  }, []);

  // Apply text highlight when we have a request and the target page is visible.
  // Uses MutationObserver to reliably wait for textLayer rendering.
  useEffect(() => {
    if (!highlightRequest?.text) return;
    const { page, text, quelle } = highlightRequest;

    let cancelled = false;
    let observer: MutationObserver | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // German stopwords to skip in paragraph scoring
    const STOPWORDS = new Set([
      'und', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem', 'einen',
      'ist', 'hat', 'sind', 'war', 'wird', 'für', 'von', 'mit', 'auf', 'aus', 'bei', 'als',
      'vom', 'zum', 'zur', 'nach', 'über', 'unter', 'vor', 'hinter', 'seit', 'durch', 'gegen',
      'ohne', 'bis', 'oder', 'aber', 'nicht', 'sich', 'auch', 'nur', 'noch', 'wie', 'kann',
      'wird', 'wenn', 'wir', 'sie', 'ich', 'ihr', 'sein', 'haben', 'werden', 'dass', 'diese',
      'dieser', 'dieses', 'einem', 'seinen', 'seiner', 'ihre', 'ihrer',
    ]);

    /** Group text-layer spans into logical paragraphs by Y-position proximity */
    function collectParagraphs(textLayer: HTMLElement): { spans: HTMLElement[]; text: string }[] {
      const allSpans = Array.from(textLayer.querySelectorAll('span')) as HTMLElement[];
      if (allSpans.length === 0) return [];

      const paragraphs: { spans: HTMLElement[]; text: string }[] = [];
      let currentPara: HTMLElement[] = [];
      let lastBottom = -Infinity;

      for (const span of allSpans) {
        const rect = span.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        // Large vertical gap (> 1.5x line height) = new paragraph
        const gap = rect.top - lastBottom;
        const lineHeight = rect.height || 12;
        if (currentPara.length > 0 && gap > lineHeight * 1.5) {
          const paraText = currentPara.map(s => s.textContent || '').join(' ');
          if (paraText.trim()) paragraphs.push({ spans: [...currentPara], text: paraText });
          currentPara = [];
        }
        currentPara.push(span);
        lastBottom = rect.bottom;
      }
      if (currentPara.length > 0) {
        const paraText = currentPara.map(s => s.textContent || '').join(' ');
        if (paraText.trim()) paragraphs.push({ spans: [...currentPara], text: paraText });
      }
      return paragraphs;
    }

    /** Extract meaningful keywords from text, filtering stopwords and short tokens */
    function extractKeywords(input: string): string[] {
      return input
        .toLowerCase()
        .replace(/[^\wäöüß]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOPWORDS.has(w));
    }

    /** Score a paragraph by keyword overlap */
    function scoreParagraph(paraText: string, keywords: string[]): number {
      const lower = paraText.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score++;
      }
      return score;
    }

    const doHighlight = (textLayer: HTMLElement) => {
      const mark = new Mark(textLayer);
      mark.unmark({ className: 'source-highlight' });
      mark.unmark({ className: 'source-highlight-para' });

      let matchCount = 0;

      // Strategy 1: exact regex match of the value
      try {
        const escaped = escapeForRegex(text);
        mark.markRegExp(new RegExp(escaped, 'gi'), {
          className: 'source-highlight',
          done: (count: number) => { matchCount = count; },
        });
      } catch {
        // ignore regex errors
      }

      // Strategy 2: fuzzy match (handles span boundaries)
      if (matchCount === 0) {
        mark.mark(text, {
          className: 'source-highlight',
          separateWordSearch: false,
          done: (count: number) => { matchCount = count; },
        });
      }

      // Strategy 2b: Stem/prefix match — handles Einzelunternehmen vs Einzelunternehmer,
      // Schuldnerin vs Schuldner, Zahlungsunfähigkeit vs zahlungsunfähig etc.
      if (matchCount === 0 && text.length >= 5) {
        // Try progressively shorter prefixes of the search text
        const minLen = Math.max(5, Math.floor(text.length * 0.7));
        for (let len = text.length - 1; len >= minLen && matchCount === 0; len--) {
          const prefix = text.slice(0, len);
          try {
            const escaped = escapeForRegex(prefix);
            mark.markRegExp(new RegExp(escaped, 'gi'), {
              className: 'source-highlight',
              done: (count: number) => { matchCount = count; },
            });
          } catch { /* ignore */ }
        }
      }

      // Strategy 3: Paragraph scoring — find the best-matching paragraph
      // Uses keywords from both the value AND the quelle description
      if (matchCount === 0) {
        const keywords = [
          ...extractKeywords(text),
          ...extractKeywords(quelle || ''),
        ];
        // Deduplicate
        const uniqueKeywords = [...new Set(keywords)];

        if (uniqueKeywords.length > 0) {
          const paragraphs = collectParagraphs(textLayer);
          let bestScore = 0;
          let bestPara: { spans: HTMLElement[]; text: string } | null = null;

          for (const para of paragraphs) {
            const score = scoreParagraph(para.text, uniqueKeywords);
            if (score > bestScore) {
              bestScore = score;
              bestPara = para;
            }
          }

          // Only highlight if we have a strong match (at least 3 keywords or 50%+ overlap)
          // Higher threshold prevents wrong-paragraph highlighting in dense legal documents
          if (bestPara && (bestScore >= 3 || (uniqueKeywords.length > 0 && bestScore / uniqueKeywords.length >= 0.5))) {
            for (const span of bestPara.spans) {
              span.classList.add('source-highlight-para');
            }
            matchCount = 1;
          }
        }
      }

      // Scroll the first match into view
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const first = textLayer.querySelector('mark.source-highlight, .source-highlight-para');
          if (first instanceof HTMLElement) {
            first.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          }
        });
      });
    };

    const tryHighlight = () => {
      if (cancelled) return;
      const pageEl = pageRefs.current.get(page);
      if (!pageEl) return false;

      const textLayer = pageEl.querySelector('.textLayer') as HTMLElement | null;
      if (textLayer && textLayer.childNodes.length > 0) {
        doHighlight(textLayer);
        return true;
      }
      return false;
    };

    // Try immediately
    if (tryHighlight()) return;

    // Watch for textLayer to appear via MutationObserver
    const pageEl = pageRefs.current.get(page);
    if (pageEl) {
      observer = new MutationObserver(() => {
        if (tryHighlight()) {
          observer?.disconnect();
          if (retryTimer) clearTimeout(retryTimer);
        }
      });
      observer.observe(pageEl, { childList: true, subtree: true });
    }

    // Safety timeout: stop observing after 5s
    retryTimer = setTimeout(() => {
      observer?.disconnect();
      tryHighlight(); // one last attempt
    }, 5000);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [highlightRequest]);

  // Fit-page width: scale so the full page height fits the container
  const pageWidth = useMemo(() => {
    if (!containerWidth || !containerHeight) return undefined;
    const maxWidth = containerWidth - 8;
    const pageLabel = 24; // page number label + margins
    const fitHeight = containerHeight - pageLabel;
    const fitPageWidth = fitHeight * pageAspectRatio;
    const baseWidth = Math.min(maxWidth, fitPageWidth);
    return Math.round(baseWidth * zoom);
  }, [containerWidth, containerHeight, pageAspectRatio, zoom]);

  const placeholderHeight = useMemo(() => {
    if (!pageWidth) return 800;
    return Math.round(pageWidth / pageAspectRatio) + 24;
  }, [pageWidth, pageAspectRatio]);

  const zoomIn = useCallback(() => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))), []);
  const zoomReset = useCallback(() => setZoom(1.0), []);

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
        <div className="w-[45%] min-w-[340px] flex flex-col bg-surface-high border-r border-border">
          {/* Toolbar */}
          <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-border text-[10px] text-text-dim">
            {allDocs.length > 1 ? (
              <select
                value={activeDocIndex}
                onChange={e => setActiveDocIndex(Number(e.target.value))}
                className="truncate flex-1 min-w-0 mr-3 bg-transparent border border-border/60 rounded px-1.5 py-0.5 text-[10px] text-text cursor-pointer"
              >
                <option value={-1}>Alle Dokumente ({allDocs.length})</option>
                {allDocs.map((d, i) => (
                  <option key={i} value={i}>{d.label}</option>
                ))}
              </select>
            ) : (
              <span className="truncate flex-1 min-w-0 mr-3" title={activeFile.name}>{activeFile.name}</span>
            )}
            <div className="flex items-center gap-3">
              {/* Zoom controls */}
              <div className="flex items-center gap-1">
                <button
                  onClick={zoomOut}
                  disabled={zoom <= ZOOM_MIN}
                  className="px-1.5 py-0.5 bg-surface-high border border-border rounded-sm hover:border-accent disabled:opacity-30 disabled:cursor-default transition-colors"
                  title="Verkleinern"
                >
                  &minus;
                </button>
                <button
                  onClick={zoomReset}
                  className="px-1.5 py-0.5 bg-surface-high border border-border rounded-sm hover:border-accent transition-colors min-w-[40px] text-center"
                  title="Ganze Seite"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  onClick={zoomIn}
                  disabled={zoom >= ZOOM_MAX}
                  className="px-1.5 py-0.5 bg-surface-high border border-border rounded-sm hover:border-accent disabled:opacity-30 disabled:cursor-default transition-colors"
                  title="Vergrößern"
                >
                  +
                </button>
              </div>
              {/* Page navigation */}
              <div className="flex items-center gap-1">
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
          </div>

          {/* Scrollable PDF area */}
          <div ref={containerRef} className="flex-1 overflow-auto">
            {loadError ? (
              <div className="flex items-center justify-center h-full text-ie-red text-xs p-4">
                {loadError}
              </div>
            ) : showAll ? (
              /* Concatenated view: all documents with separators */
              allDocs.map((doc, docIdx) => (
                <div key={docIdx}>
                  {docIdx > 0 && (
                    <div className="flex items-center gap-2 py-2 px-4 bg-accent/5 border-y border-accent/20">
                      <div className="flex-1 h-px bg-accent/20" />
                      <span className="text-[9px] text-accent font-mono whitespace-nowrap">{doc.label}</span>
                      <div className="flex-1 h-px bg-accent/20" />
                    </div>
                  )}
                  <Document
                    file={{ url: URL.createObjectURL(doc.file) }}
                    options={PDFJS_OPTIONS}
                    onLoadSuccess={docIdx === 0 ? onDocLoadSuccess : undefined}
                    onLoadError={(err) => setLoadError(err?.message || 'PDF konnte nicht geladen werden')}
                    loading={
                      <div className="flex items-center justify-center h-32 text-text-muted text-xs">
                        {doc.label} wird gerendert...
                      </div>
                    }
                  >
                    {/* Render all pages without lazy loading for concatenated view */}
                    {Array.from({ length: 200 }, (_, i) => (
                      <Page
                        key={`${docIdx}-${i}`}
                        pageNumber={i + 1}
                        width={pageWidth}
                        renderTextLayer={true}
                        renderAnnotationLayer={false}
                        error={null}
                      />
                    )).slice(0, 200)}
                  </Document>
                </div>
              ))
            ) : !fileProp ? (
              <div className="flex items-center justify-center h-full text-text-muted text-xs">
                PDF wird geladen...
              </div>
            ) : (
              <Document
                file={fileProp}
                options={PDFJS_OPTIONS}
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
                      className="mb-1 border-b border-border/30 flex flex-col items-center"
                      style={!inRange ? { height: `${placeholderHeight}px` } : undefined}
                    >
                      {inRange ? (
                        <Page
                          pageNumber={pageNum}
                          width={pageWidth}
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
