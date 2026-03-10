/**
 * Fuzzy matching utilities for verifying extracted values against page text.
 */

/**
 * Compute the Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Parse a German-format number string into a JavaScript number.
 * German format uses '.' as thousands separator and ',' as decimal separator.
 * Examples: "12.345,67" → 12345.67, "1.234" → 1234, "42" → 42
 * Returns null if the string doesn't look like a number.
 */
function parseGermanNumber(str: string): number | null {
  const trimmed = str.trim();
  // Match German number patterns: optional sign, digits with optional . thousands separator, optional , decimal
  const germanMatch = trimmed.match(/^-?(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)$/);
  if (germanMatch) {
    const normalized = trimmed.replace(/\./g, '').replace(',', '.');
    const num = parseFloat(normalized);
    return isNaN(num) ? null : num;
  }
  // Also try standard format (e.g. "12345.67")
  const standardMatch = trimmed.match(/^-?\d+(?:\.\d+)?$/);
  if (standardMatch) {
    const num = parseFloat(trimmed);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Normalize a string for comparison: lowercase, collapse whitespace, trim.
 */
function normalize(str: string): string {
  return str.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Check if a value can be found in page text using multiple matching strategies.
 *
 * Strategies (tried in order):
 * 1. Skip booleans and very short values (≤2 chars) → return true
 * 2. Normalized containment — case-insensitive, whitespace-collapsed
 * 3. Numeric comparison — parse German number format, find in page text
 * 4. Word-part matching — all words ≥3 chars appear in page text
 * 5. Levenshtein sliding window — for values 5-80 chars, 15% error threshold
 */
export function fuzzyFindInText(value: string, pageText: string): boolean {
  // Strategy 1: Skip booleans and very short values
  const lowerValue = value.toLowerCase().trim();
  if (['true', 'false', 'ja', 'nein'].includes(lowerValue)) {
    return true;
  }
  if (value.trim().length <= 2) {
    return true;
  }

  const normalizedValue = normalize(value);
  const normalizedText = normalize(pageText);

  // Strategy 2: Normalized containment
  if (normalizedText.includes(normalizedValue)) {
    return true;
  }

  // Strategy 3: Numeric comparison
  const valueNum = parseGermanNumber(value.trim());
  if (valueNum !== null) {
    // Extract all number-like tokens from the page text (both German and standard format)
    const numberPattern = /\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?|\d+(?:\.\d+)?/g;
    const matches = pageText.match(numberPattern);
    if (matches) {
      for (const match of matches) {
        const pageNum = parseGermanNumber(match);
        if (pageNum !== null && Math.abs(pageNum - valueNum) < 0.001) {
          return true;
        }
      }
    }
  }

  // Strategy 4: Word-part matching
  const words = normalizedValue.split(/\s+/).filter(w => w.length >= 3);
  if (words.length > 0 && words.every(w => normalizedText.includes(w))) {
    return true;
  }

  // Strategy 5: Levenshtein sliding window
  const valLen = normalizedValue.length;
  if (valLen >= 5 && valLen <= 80) {
    const maxErrors = Math.floor(valLen * 0.15);
    // Try window sizes around the value length to account for insertions/deletions
    const minWin = Math.max(1, valLen - maxErrors);
    const maxWin = valLen + maxErrors;
    for (let winSize = minWin; winSize <= maxWin; winSize++) {
      for (let i = 0; i <= normalizedText.length - winSize; i++) {
        const window = normalizedText.substring(i, i + winSize);
        if (levenshtein(normalizedValue, window) <= maxErrors) {
          return true;
        }
      }
    }
  }

  return false;
}
