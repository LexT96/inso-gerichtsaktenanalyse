import type { VerwalterProfile } from '../types/extraction';

/** Normalize a name for matching: lowercase, strip common titles + punctuation, collapse whitespace. */
export function normalizeVerwalterName(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(/[.,;]/g, ' ');
  const titles = [
    'professor', 'prof ', 'prof.', 'prof',
    'rechtsanwältin', 'rechtsanwalt',
    'rain ', 'rain.', 'rain', 'ra ', 'ra.', 'ra',
    'dr ', 'dr.', 'dr',
    'll m', 'll.m', 'llm',
    'mag ', 'mag.', 'mag',
    'mbb',
  ];
  for (const t of titles) {
    s = s.split(t).join(' ');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Find a VerwalterProfile whose name matches the extracted gutachter_name.
 * Returns the profile only when exactly one matches (avoids ambiguity).
 * A profile matches when every ≥3-char token from the needle appears in the profile's normalized name.
 */
export function findMatchingVerwalter(
  profiles: VerwalterProfile[],
  extractedName: string | null | undefined,
): VerwalterProfile | null {
  if (!extractedName || !extractedName.trim() || profiles.length === 0) return null;
  const needle = normalizeVerwalterName(extractedName);
  if (!needle) return null;
  const needleTokens = needle.split(' ').filter(t => t.length >= 3);
  if (needleTokens.length === 0) return null;
  const matches = profiles.filter(p => {
    const hay = normalizeVerwalterName(p.name);
    return needleTokens.every(t => hay.includes(t));
  });
  return matches.length === 1 ? matches[0] : null;
}
