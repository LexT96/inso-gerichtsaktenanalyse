import { useState } from 'react';
import { Badge } from './Badge';
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
  return w === null || w === undefined || w === '' || w === 0;
}

interface DataFieldProps {
  label: string;
  field: AnySourced;
  isCurrency?: boolean;
}

export function DataField({ label, field, isCurrency }: DataFieldProps) {
  const [showSrc, setShowSrc] = useState(false);
  const w = getWert(field);
  const q = getQuelle(field);
  const empty = fieldIsEmpty(field);

  const displayValue = (): string => {
    if (empty) return '—';
    if (isCurrency && typeof w === 'number') {
      return `${w.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €`;
    }
    if (typeof w === 'boolean') return w ? 'Ja' : 'Nein';
    return String(w);
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
              onClick={() => setShowSrc(!showSrc)}
              className="bg-transparent border border-border rounded-sm text-text-muted text-[8px] px-1.5 py-px cursor-pointer font-mono tracking-wide hover:border-accent hover:text-accent transition-colors"
            >
              {showSrc ? '×' : 'Q'}
            </button>
          )}
        </div>
        {showSrc && q && (
          <div className="mt-0.5 px-2 py-0.5 bg-bg border border-border rounded-sm text-[10px] text-accent italic">
            ↳ {q}
          </div>
        )}
      </div>
      <Badge type={empty ? 'missing' : 'found'} />
    </div>
  );
}
