import { getFieldAuthority } from '../utils/fieldAuthority';
import { logger } from '../utils/logger';
import type { ExtractionResult, ExtractionCandidate, MergeDiff, MergeFieldChange, SegmentSourceType } from '../types/extraction';

/**
 * Navigate a dotted path in a nested object and return the leaf value.
 * Returns undefined if any intermediate key is missing.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Determine the source type of an existing field value based on its quelle string.
 * Heuristic: look for document type keywords in the quelle.
 */
function inferSourceType(quelle: string): SegmentSourceType {
  const q = quelle.toLowerCase();
  if (/beschluss|verfügung/.test(q)) return 'beschluss';
  if (/antrag|insolvenzantrag/.test(q)) return 'insolvenzantrag';
  if (/pzu|zustellung/.test(q)) return 'pzu';
  if (/handelsregister|hr-auszug|hrb/.test(q)) return 'handelsregister';
  if (/meldeauskunft|meldebescheinigung/.test(q)) return 'meldeauskunft';
  if (/fragebogen|formular/.test(q)) return 'fragebogen';
  if (/grundbuch/.test(q)) return 'grundbuch';
  if (/gerichtsvollzieher/.test(q)) return 'gerichtsvollzieher';
  if (/vollstreckungsportal|schuldnerverzeichnis/.test(q)) return 'vollstreckungsportal';
  return 'sonstiges';
}

/**
 * Compare extraction candidates from a new document against the existing result.
 * Categorizes each candidate as new, updated, conflict, or unchanged.
 */
export function computeMergeDiff(
  existing: ExtractionResult,
  candidates: ExtractionCandidate[],
): MergeDiff {
  const diff: MergeDiff = {
    newFields: [],
    updatedFields: [],
    conflicts: [],
    newForderungen: [],
    updatedForderungen: [],
  };

  for (const candidate of candidates) {
    const existingField = getNestedValue(existing as unknown as Record<string, unknown>, candidate.fieldPath);

    // Not a SourcedValue object -- skip
    if (existingField !== undefined && existingField !== null && typeof existingField === 'object' && 'wert' in existingField) {
      const field = existingField as { wert: unknown; quelle: string; pruefstatus?: string };
      const existingWert = field.wert;
      const existingQuelle = field.quelle || '';

      // Same value -- no change needed
      if (String(existingWert) === String(candidate.wert)) continue;

      // Existing is empty -- new field
      if (existingWert === null || existingWert === undefined || existingWert === '') {
        diff.newFields.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
        });
        continue;
      }

      // Manual correction -- always conflict
      if (field.pruefstatus === 'manuell') {
        diff.conflicts.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
          oldWert: existingWert,
          oldQuelle: existingQuelle,
          reason: 'Feld wurde manuell korrigiert',
        });
        continue;
      }

      // Both have values -- check authority
      const authority = getFieldAuthority(candidate.fieldPath);
      const existingSourceType = inferSourceType(existingQuelle);
      const existingRank = authority.indexOf(existingSourceType);
      const newRank = authority.indexOf(candidate.segmentType);
      const existingAuth = existingRank === -1 ? 999 : existingRank;
      const newAuth = newRank === -1 ? 999 : newRank;

      if (newAuth < existingAuth) {
        // New source has higher authority -- suggest update
        diff.updatedFields.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
          oldWert: existingWert,
          oldQuelle: existingQuelle,
          reason: `${candidate.segmentType} hat höhere Autorität als ${existingSourceType}`,
        });
      } else if (newAuth === existingAuth) {
        // Equal authority -- conflict, user decides
        diff.conflicts.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
          oldWert: existingWert,
          oldQuelle: existingQuelle,
          reason: 'Gleiche Autoritätsstufe, unterschiedliche Werte',
        });
      }
      // else: existing has higher authority -- skip silently
    } else {
      // Field doesn't exist in result or is not a SourcedValue -- treat as new
      if (candidate.wert !== null && candidate.wert !== undefined && candidate.wert !== '') {
        diff.newFields.push({
          path: candidate.fieldPath,
          wert: candidate.wert,
          quelle: candidate.quelle,
        });
      }
    }
  }

  logger.info('Merge-Diff berechnet', {
    newFields: diff.newFields.length,
    updatedFields: diff.updatedFields.length,
    conflicts: diff.conflicts.length,
    newForderungen: diff.newForderungen.length,
    updatedForderungen: diff.updatedForderungen.length,
  });

  return diff;
}

/**
 * Apply accepted merge changes to an ExtractionResult.
 * Returns the modified result (mutates in place).
 */
export function applyMergeDiff(
  result: ExtractionResult,
  diff: MergeDiff,
  accepted: Set<string>,
): ExtractionResult {
  const allChanges = [...diff.newFields, ...diff.updatedFields, ...diff.conflicts];

  for (const change of allChanges) {
    if (!accepted.has(change.path)) continue;

    const parts = change.path.split('.');
    let obj: Record<string, unknown> = result as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') {
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    const leafKey = parts[parts.length - 1];
    const field = obj[leafKey] as Record<string, unknown> | undefined;
    if (field && typeof field === 'object') {
      field.wert = change.wert;
      field.quelle = change.quelle;
      field.verifiziert = false;
      delete field.pruefstatus; // Reset -- it's a fresh extraction, not manually set
    } else {
      obj[leafKey] = { wert: change.wert, quelle: change.quelle, verifiziert: false };
    }
  }

  return result;
}
