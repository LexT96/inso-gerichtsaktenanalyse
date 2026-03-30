import { usePdf } from '../../contexts/PdfContext';

interface SourcedItemProps {
  item: { wert: string | null; quelle: string } | string;
  variant?: 'default' | 'warning';
}

function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function SourcedItem({ item, variant = 'default' }: SourcedItemProps) {
  const { goToPageAndHighlight, totalPages } = usePdf();

  // Handle both old string format and new {wert, quelle} format
  const text = typeof item === 'string' ? item : (item.wert ?? '');
  const quelle = typeof item === 'string' ? '' : (item.quelle ?? '');
  const pageNum = quelle ? parsePageNumber(quelle) : null;

  if (!text) return null;

  const handleClick = () => {
    if (pageNum && totalPages > 0) {
      goToPageAndHighlight(pageNum, text || undefined);
    }
  };

  const baseClasses = variant === 'warning'
    ? 'p-2 px-3 mb-1.5 bg-ie-amber-bg border border-ie-amber-border rounded-md text-ie-amber text-[11px] font-sans'
    : 'm-0 text-[11px] leading-7 text-text-dim font-sans py-0.5';

  return (
    <div className={`${baseClasses} flex items-start gap-2`}>
      <span className="flex-1">{text}</span>
      {quelle && (
        <button
          onClick={handleClick}
          title={quelle}
          className={`flex-shrink-0 bg-transparent border rounded-md text-[8px] px-1.5 py-0.5 cursor-pointer font-mono tracking-wide transition-colors mt-0.5
            ${pageNum
              ? 'border-ie-blue-border text-ie-blue hover:border-ie-blue hover:text-ie-blue'
              : 'border-border text-text-muted'
            }`}
        >
          {pageNum ? `S.${pageNum}` : 'Q'}
        </button>
      )}
    </div>
  );
}
