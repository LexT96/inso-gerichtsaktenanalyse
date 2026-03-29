/**
 * Few-Shot Collector — builds extraction examples from human corrections.
 *
 * Every time a user corrects a field via the Prüfliste (fieldUpdate route),
 * we record the correction. Over time, this builds a library of
 * "before → after" examples that can be injected into the extraction prompt
 * as few-shot examples, teaching the model common error patterns.
 */

import { getDb } from '../db/database';
import { logger } from './logger';

export interface FewShotCorrection {
  field: string;
  original_value: string;
  corrected_value: string;
  count: number;
}

/**
 * Record a human correction for few-shot learning.
 * Called from fieldUpdate route after each manual correction.
 */
export function recordCorrection(
  fieldPath: string,
  originalValue: string | null,
  correctedValue: string | null,
  pruefstatus: string
): void {
  if (pruefstatus !== 'korrigiert' && pruefstatus !== 'manuell') return;
  if (!correctedValue || correctedValue === originalValue) return;

  try {
    const db = getDb();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS few_shot_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_path TEXT NOT NULL,
        original_value TEXT,
        corrected_value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(
      'INSERT INTO few_shot_corrections (field_path, original_value, corrected_value) VALUES (?, ?, ?)'
    ).run(fieldPath, originalValue ?? '', correctedValue);

    logger.debug('Few-shot correction recorded', { fieldPath, originalValue, correctedValue });
  } catch (err) {
    logger.warn('Failed to record few-shot correction', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Get the most common corrections as few-shot examples.
 * Only returns patterns that occurred at least twice (not one-off corrections).
 */
export function getFewShotExamples(limit: number = 5): FewShotCorrection[] {
  try {
    const db = getDb();

    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='few_shot_corrections'"
    ).get();
    if (!tableExists) return [];

    return db.prepare(`
      SELECT
        field_path as field,
        original_value,
        corrected_value,
        COUNT(*) as count
      FROM few_shot_corrections
      GROUP BY field_path, original_value, corrected_value
      HAVING count >= 2
      ORDER BY count DESC
      LIMIT ?
    `).all(limit) as FewShotCorrection[];
  } catch {
    return [];
  }
}

/**
 * Generate a prompt snippet from collected corrections.
 * Returns empty string if not enough corrections yet.
 */
export function buildFewShotPromptSnippet(): string {
  const examples = getFewShotExamples(5);
  if (examples.length === 0) return '';

  const lines = examples.map(e =>
    `- ${e.field}: "${e.original_value}" wurde ${e.count}x zu "${e.corrected_value}" korrigiert`
  );

  return `\n\nLERNHINWEISE AUS BISHERIGEN KORREKTUREN:\nDie folgenden Muster wurden bei früheren Extraktionen häufig manuell korrigiert. Beachte diese bei der aktuellen Extraktion:\n${lines.join('\n')}\n`;
}
