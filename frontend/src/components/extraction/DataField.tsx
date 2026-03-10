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
    if (empty) return '\u2014';
    if (isCurrency && typeof w === 'number') {
      return `${w.toLocaleString('de-DE', { minimumFractionDigits: 2 })} \u20ac`;
    }
    if (typeof w === 'boolean') return w ? 'Ja' : 'Nein';
    if (w === 0) return '0';
    return String(w);
  };

  /** Raw value for highlighting — no currency/boolean formatting that won't match PDF text */
  const rawSearchText = (): string | undefined => {
    if (empty) return undefined;
    if (w === null || w === undefined) return undefined;
    const s = String(w).trim();
    return s || undefined;
  };

  const handleQuelleClick = () => {
    if (pageNum && totalPages > 0) {
      goToPageAndHighlight(pageNum, rawSearchText());
    }
    setShowSrc(!showSrc);
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
              title={isUnverified ? 'Quelle nicht verifiziert' : pageNum ? `Seite ${pageNum} anzeigen` : 'Quelle anzeigen'}
              className={`bg-transparent border rounded-sm text-[8px] px-1.5 py-px cursor-pointer font-mono tracking-wide transition-colors
                ${showSrc
                  ? 'border-accent text-accent'
                  : isUnverified
                    ? 'border-ie-amber-border text-ie-amber'
                    : pageNum
                      ? 'border-ie-blue-border text-ie-blue hover:border-ie-blue hover:text-ie-blue'
                      : 'border-border text-text-muted hover:border-accent hover:text-accent'
                }`}
            >
              {showSrc ? '\u00d7' : isUnverified ? '?' : pageNum ? `S.${pageNum}` : 'Q'}
            </button>
          )}
        </div>
        {showSrc && q && (
          <div
            className={`mt-0.5 px-2 py-0.5 bg-bg border rounded-sm text-[10px] italic
              ${pageNum ? 'border-ie-blue-border text-ie-blue cursor-pointer hover:border-ie-blue' : 'border-border text-accent'}`}
            onClick={() => {
              if (pageNum && totalPages > 0) {
                goToPageAndHighlight(pageNum, rawSearchText());
              }
            }}
          >
            {'\u21b3'} {q}
          </div>
        )}
      </div>
      <Badge type={empty ? 'missing' : verifiziert === true ? 'found' : 'unverified'} />
    </div>
  );
}
