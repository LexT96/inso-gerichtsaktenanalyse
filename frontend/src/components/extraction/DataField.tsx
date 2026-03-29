import { useState } from 'react';
import { Badge } from './Badge';
import { usePdf } from '../../contexts/PdfContext';
import type { SourcedValue, SourcedNumber, SourcedBoolean } from '../../types/extraction';

type AnySourced = SourcedValue | SourcedNumber | SourcedBoolean | null | undefined;

function getWert(field: AnySourced): string | number | boolean | null {
  if (!field) return null;
  if (typeof field === 'object' && 'wert' in field) return field.wert;
  return null;
}

function getQuelle(field: AnySourced): string {
  if (!field) return '';
  if (typeof field === 'object' && 'quelle' in field) return field.quelle || '';
  return '';
}

function fieldIsEmpty(field: AnySourced): boolean {
  const w = getWert(field);
  return w === null || w === undefined || w === '';
}

function getVerifiziert(field: AnySourced): boolean | undefined {
  if (!field) return undefined;
  if (typeof field === 'object' && 'verifiziert' in field) return field.verifiziert;
  return undefined;
}

/** Extract page number from quelle string.
 *  Handles: Seite 3, Seiten 3-5, S. 3, S.3, S3, page 3, p. 3, p.3
 */
function parsePageNumber(quelle: string): number | null {
  const match = quelle.match(/(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

interface DataFieldProps {
  label: string;
  field: AnySourced;
  isCurrency?: boolean;
}

export function DataField({ label, field, isCurrency }: DataFieldProps) {
  const [showSrc, setShowSrc] = useState(false);
  const { goToPageAndHighlight, totalPages } = usePdf();
  const w = getWert(field);
  const q = getQuelle(field);
  const empty =
    fieldIsEmpty(field) ||
    (isCurrency && (w === 0 || w === null) && !q?.trim());
  const pageNum = q ? parsePageNumber(q) : null;
  const verifiziert = getVerifiziert(field);
  const isUnverified = verifiziert === false;

  const displayValue = (): string => {
    if (empty) return '—';
    if (isCurrency && typeof w === 'number') {
      return `${w.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`;
    }
    if (typeof w === 'boolean') return w ? 'Ja' : 'Nein';
    if (w === 0) return '0';
    return String(w);
  };

  /** Raw value for highlighting — format numbers in German style to match PDF text */
  const rawSearchText = (): string | undefined => {
    if (empty) return undefined;
    if (w === null || w === undefined) return undefined;
    if (typeof w === 'number') {
      // Format as German number (45678.5 → "45.678,50") to match PDF text
      return w.toLocaleString('de-DE', { minimumFractionDigits: w % 1 !== 0 ? 2 : 0 });
    }
    if (typeof w === 'boolean') return undefined;
    const s = String(w).trim();
    return s || undefined;
  };

  const handleQuelleClick = () => {
    // Always try to jump — goToPageAndHighlight handles the case when PDF isn't loaded
    if (pageNum) {
      goToPageAndHighlight(pageNum, rawSearchText(), q);
    }
    // Always show source text (toggle off only via × button)
    if (!showSrc) setShowSrc(true);
  };

  return (
    <div className="flex items-start py-1.5 border-b border-border gap-2">
      <span className="flex-shrink-0 w-[180px] text-[11px] text-text-dim pt-0.5">{label}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-mono ${empty ? 'text-text-muted' : 'text-text'}`}>
            {displayValue()}
          </span>
          {q && (
            <button
              onClick={handleQuelleClick}
              title={pageNum ? `Seite ${pageNum} im PDF anzeigen` : 'Quelle anzeigen'}
              className={`bg-transparent border rounded text-[8px] px-1.5 py-px cursor-pointer font-mono tracking-wide transition-all hover:scale-105 active:scale-95
                ${isUnverified
                  ? 'border-ie-amber-border text-ie-amber'
                  : pageNum
                    ? 'border-ie-blue-border text-ie-blue hover:border-ie-blue hover:bg-ie-blue/5'
                    : 'border-border text-text-muted hover:border-accent hover:text-accent'
                }`}
            >
              {isUnverified ? '?' : pageNum ? `S.${pageNum}` : 'Q'}
            </button>
          )}
          {showSrc && q && (
            <button
              onClick={() => setShowSrc(false)}
              className="text-[8px] text-text-muted hover:text-accent transition-colors"
              title="Quelle ausblenden"
            >
              ×
            </button>
          )}
        </div>
        {showSrc && q && (
          <div
            className={`mt-0.5 px-2 py-0.5 bg-bg border rounded-md text-[10px] italic transition-colors
              ${pageNum ? 'border-ie-blue-border text-ie-blue cursor-pointer hover:bg-ie-blue/5' : 'border-border text-accent'}`}
            onClick={() => {
              if (pageNum && totalPages > 0) {
                goToPageAndHighlight(pageNum, rawSearchText(), q);
              }
            }}
          >
            ↳ {q}
          </div>
        )}
      </div>
      <Badge type={empty ? 'missing' : verifiziert === true ? 'found' : 'unverified'} />
    </div>
  );
}
