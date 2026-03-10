/**
 * Utilities for parsing and replacing page numbers in quelle strings.
 */

const PAGE_REGEX = /(?:Seiten?\s+|S\.?\s*|page\s+|p\.?\s*)(\d+)/i;

/**
 * Extract the first page number from a quelle string.
 * Returns null if no page reference is found.
 */
export function parsePageNumber(quelle: string): number | null {
  if (!quelle) return null;
  const match = quelle.match(PAGE_REGEX);
  if (!match) return null;
  return parseInt(match[1], 10);
}

/**
 * Replace the page number in a quelle string with a new one,
 * preserving the original format (e.g. "Seite 3" stays "Seite X", "S.3" stays "S.X").
 */
export function replacePageNumber(quelle: string, newPage: number): string {
  return quelle.replace(PAGE_REGEX, (fullMatch, oldNum) => {
    return fullMatch.replace(oldNum, String(newPage));
  });
}
