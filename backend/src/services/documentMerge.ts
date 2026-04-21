import { getFieldAuthority } from '../utils/fieldAuthority';
import { logger } from '../utils/logger';
import type {
  ExtractionResult,
  ExtractionCandidate,
  MergeDiff,
  MergeFieldChange,
  SegmentSourceType,
  Einzelforderung,
  Aktivum,
  AnfechtbarerVorgang,
  Forderungen,
  AktivaAnalyse,
  Anfechtungsanalyse,
} from '../types/extraction';

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
 * Normalize a string for similarity comparison:
 * lowercase, collapse whitespace, strip punctuation, strip common legal suffixes.
 */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[.,;:/\\&()\[\]"']/g, ' ')
    .replace(/\bverfahren\b/g, '') // "Regelinsolvenz" ≈ "Regelinsolvenzverfahren"
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance — iterative, O(n*m) */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Returns true if two values are substantially the same — handles whitespace,
 * casing, minor typos, common suffix/prefix additions. Used to suppress
 * redundant "update" suggestions in the merge diff.
 */
function areSubstantiallySimilar(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return true;
  if (!na || !nb) return false;
  // One fully contains the other (e.g. "Amtsgericht Wittlich" vs "Amtsgericht Wittlich - Insolvenzabteilung")
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = Math.min(na.length, nb.length);
    const longer = Math.max(na.length, nb.length);
    if (shorter / longer >= 0.5) return true;
  }
  // Normalized Levenshtein similarity ≥ 0.85 → treat as same
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return maxLen > 0 && 1 - dist / maxLen >= 0.85;
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

      // Normalized + fuzzy match: skip near-identical values
      // (whitespace, casing, trailing suffixes like "- Insolvenzabteilung",
      //  minor typos, synonyms like "Regelinsolvenz" vs "Regelinsolvenzverfahren")
      if (existingWert != null && candidate.wert != null &&
          areSubstantiallySimilar(String(existingWert), String(candidate.wert))) {
        continue;
      }

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
// ─── Focused-pass array merging (auto, dedup by composite key) ───

function normKey(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function einzelforderungKey(e: Einzelforderung): string {
  const glaeubiger = normKey(e.glaeubiger?.wert);
  const betrag = typeof e.betrag?.wert === 'number' ? String(Math.round(e.betrag.wert * 100)) : '';
  const titel = normKey(e.titel?.wert);
  return `${glaeubiger}|${betrag}|${titel}`;
}

function aktivumKey(a: Aktivum): string {
  const beschreibung = normKey(a.beschreibung?.wert);
  const kategorie = normKey(a.kategorie);
  return `${beschreibung}|${kategorie}`;
}

function vorgangKey(v: AnfechtbarerVorgang): string {
  const empfaenger = normKey(v.empfaenger?.wert);
  const datum = normKey(v.datum?.wert);
  const betrag = typeof v.betrag?.wert === 'number' ? String(Math.round(v.betrag.wert * 100)) : '';
  return `${empfaenger}|${datum}|${betrag}`;
}

/**
 * Count how many items from a focused-pass result are new (not already in existing).
 * Used to build diff.arraySummary without mutating the result.
 */
export function summarizeFocusedResults(
  existing: ExtractionResult,
  focused: { forderungen?: Forderungen | null; aktiva?: AktivaAnalyse | null; anfechtung?: Anfechtungsanalyse | null },
): { newEinzelforderungen: number; newAktivaPositionen: number; newAnfechtungVorgaenge: number } {
  const summary = { newEinzelforderungen: 0, newAktivaPositionen: 0, newAnfechtungVorgaenge: 0 };

  if (focused.forderungen?.einzelforderungen) {
    const existingKeys = new Set((existing.forderungen?.einzelforderungen ?? []).map(einzelforderungKey));
    for (const e of focused.forderungen.einzelforderungen) {
      if (!existingKeys.has(einzelforderungKey(e))) summary.newEinzelforderungen++;
    }
  }
  if (focused.aktiva?.positionen) {
    const existingKeys = new Set((existing.aktiva?.positionen ?? []).map(aktivumKey));
    for (const a of focused.aktiva.positionen) {
      if (!existingKeys.has(aktivumKey(a))) summary.newAktivaPositionen++;
    }
  }
  if (focused.anfechtung?.vorgaenge) {
    const existingKeys = new Set((existing.anfechtung?.vorgaenge ?? []).map(vorgangKey));
    for (const v of focused.anfechtung.vorgaenge) {
      if (!existingKeys.has(vorgangKey(v))) summary.newAnfechtungVorgaenge++;
    }
  }
  return summary;
}

/**
 * Dedup-merge focused-pass arrays into the existing result. Mutates and returns result.
 * Append-only: existing items are preserved, new ones are added by composite-key diff.
 */
export function applyFocusedResults(
  result: ExtractionResult,
  focused: { forderungen?: Forderungen | null; aktiva?: AktivaAnalyse | null; anfechtung?: Anfechtungsanalyse | null } | undefined,
): { added: { einzelforderungen: number; aktiva: number; vorgaenge: number } } {
  const added = { einzelforderungen: 0, aktiva: 0, vorgaenge: 0 };
  if (!focused) return { added };

  if (focused.forderungen?.einzelforderungen) {
    if (!result.forderungen) {
      result.forderungen = { einzelforderungen: [] } as unknown as ExtractionResult['forderungen'];
    }
    if (!result.forderungen!.einzelforderungen) result.forderungen!.einzelforderungen = [];
    const existingKeys = new Set(result.forderungen!.einzelforderungen.map(einzelforderungKey));
    for (const e of focused.forderungen.einzelforderungen) {
      const k = einzelforderungKey(e);
      if (!existingKeys.has(k)) {
        result.forderungen!.einzelforderungen.push(e);
        existingKeys.add(k);
        added.einzelforderungen++;
      }
    }
  }

  if (focused.aktiva?.positionen) {
    if (!result.aktiva) {
      result.aktiva = { positionen: [] } as unknown as ExtractionResult['aktiva'];
    }
    if (!result.aktiva!.positionen) result.aktiva!.positionen = [];
    const existingKeys = new Set(result.aktiva!.positionen.map(aktivumKey));
    for (const a of focused.aktiva.positionen) {
      const k = aktivumKey(a);
      if (!existingKeys.has(k)) {
        result.aktiva!.positionen.push(a);
        existingKeys.add(k);
        added.aktiva++;
      }
    }
  }

  if (focused.anfechtung?.vorgaenge) {
    if (!result.anfechtung) {
      result.anfechtung = { vorgaenge: [], gesamtpotenzial: { wert: null, quelle: '' }, zusammenfassung: '' } as unknown as ExtractionResult['anfechtung'];
    }
    if (!result.anfechtung!.vorgaenge) result.anfechtung!.vorgaenge = [];
    const existingKeys = new Set(result.anfechtung!.vorgaenge.map(vorgangKey));
    for (const v of focused.anfechtung.vorgaenge) {
      const k = vorgangKey(v);
      if (!existingKeys.has(k)) {
        result.anfechtung!.vorgaenge.push(v);
        existingKeys.add(k);
        added.vorgaenge++;
      }
    }
  }

  logger.info('Focused-pass arrays auto-merged', { added });
  return { added };
}

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
