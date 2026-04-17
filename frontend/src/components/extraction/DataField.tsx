import { useState } from 'react';
import { Badge } from './Badge';
import { usePdf } from '../../contexts/PdfContext';
import { useExtractionId } from '../../contexts/ExtractionContext';
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
  fieldPath?: string;
  extractionId?: number | null;
  onFieldUpdated?: (path: string, newValue: string | null) => void;
}

export function DataField({ label, field, isCurrency, fieldPath, extractionId: extractionIdProp, onFieldUpdated }: DataFieldProps) {
  const [showSrc, setShowSrc] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const { goToPageAndHighlight, totalPages } = usePdf();
  const contextExtractionId = useExtractionId();
  const extractionId = extractionIdProp ?? contextExtractionId;
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
    // Auto-format numbers that look like EUR amounts (even in non-currency fields)
    if (typeof w === 'number' && w > 100) {
      return w.toLocaleString('de-DE', { minimumFractionDigits: 2 });
    }
    if (typeof w === 'boolean') return w ? 'Ja' : 'Nein';
    if (w === 0) return '0';
    // Format number strings that look like amounts (e.g. "1299370.35")
    const s = String(w);
    if (/^\d+\.\d{2}$/.test(s)) {
      const num = parseFloat(s);
      if (!isNaN(num) && num > 100) return num.toLocaleString('de-DE', { minimumFractionDigits: 2 });
    }
    return s;
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

  const canEdit = !!fieldPath && extractionId != null;

  const startEdit = () => {
    if (!canEdit) return;
    setEditValue(w != null ? String(w) : '');
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!fieldPath || !extractionId) return;
    setSaving(true);
    try {
      const { apiClient } = await import('../../api/client');
      const newVal = editValue.trim() || null;
      await apiClient.patch(`/extractions/${extractionId}/fields`, {
        fieldPath,
        wert: newVal,
        pruefstatus: 'korrigiert',
      });
      if (field && typeof field === 'object' && 'wert' in field) {
        (field as { wert: unknown }).wert = newVal;
      }
      onFieldUpdated?.(fieldPath, newVal);
      setEditing(false);
    } catch {
      // Silently fail — field stays in edit mode
    } finally {
      setSaving(false);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') setEditing(false);
  };

  return (
    <div className="flex items-start py-2 border-b border-border gap-2 group">
      <span className="flex-shrink-0 w-[180px] text-[12px] text-text-dim pt-0.5">{label}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              type="text"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={handleEditKeyDown}
              onBlur={saveEdit}
              autoFocus
              disabled={saving}
              className="flex-1 px-2 py-1 bg-bg border border-accent rounded-md text-[13px] font-mono text-text focus:outline-none focus:ring-2 focus:ring-accent/20"
            />
          ) : (
            <span
              className={`text-[13px] font-mono ${empty ? 'text-text-muted' : 'text-text'} ${canEdit ? 'cursor-pointer hover:text-accent transition-colors' : ''}`}
              onClick={canEdit ? startEdit : undefined}
              title={canEdit ? 'Klicken zum Bearbeiten' : undefined}
            >
              {displayValue()}
            </span>
          )}
          {canEdit && !editing && (
            <button
              onClick={startEdit}
              className="opacity-0 group-hover:opacity-100 text-[9px] text-text-muted hover:text-accent transition-all"
              title="Bearbeiten"
            >
              ✎
            </button>
          )}
          {q && (
            <button
              onClick={handleQuelleClick}
              title={pageNum ? `Seite ${pageNum} im PDF anzeigen` : 'Quelle anzeigen'}
              className={`bg-transparent border rounded-md text-[8px] px-1.5 py-0.5 cursor-pointer font-mono tracking-wide transition-all hover:scale-105 active:scale-95
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
            className={`mt-1 px-2.5 py-1 bg-bg border rounded-md text-[10px] italic transition-colors
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
      <Badge type={empty ? 'missing' : 'found'} />
    </div>
  );
}
