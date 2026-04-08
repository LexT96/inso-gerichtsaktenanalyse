#!/bin/bash
# Benchmark Claude vs GPT-5.4 on a given Akte
# Usage: ./scripts/benchmark-providers.sh path/to/akte.pdf
#
# Requires: ANTHROPIC_API_KEY and OPENAI_API_KEY in .env
# Runs both providers through the full pipeline, compares results

set -e
cd "$(dirname "$0")/.."
source .env

PDF="${1:?Usage: $0 path/to/akte.pdf}"
[ -f "$PDF" ] || { echo "File not found: $PDF"; exit 1; }

echo "=== Provider Benchmark ==="
echo "PDF: $PDF"
echo ""

# Run Claude extraction
echo ">>> Running Claude Sonnet extraction..."
EXTRACTION_PROVIDER= \
OPENAI_API_KEY= \
DATABASE_PATH=backend/data/benchmark-claude.db \
npx tsx backend/src/scripts/verify-extraction.ts "$PDF" 2>&1 | tail -3

CLAUDE_JSON="${PDF%.pdf}-extraction.json"
cp "$CLAUDE_JSON" /tmp/benchmark-claude.json
echo "Claude result saved"
echo ""

# Run GPT extraction
echo ">>> Running GPT-5.4 extraction..."
EXTRACTION_PROVIDER=openai \
OPENAI_API_KEY="$OPENAI_API_KEY" \
OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.4}" \
DATABASE_PATH=backend/data/benchmark-gpt.db \
npx tsx backend/src/scripts/verify-extraction.ts "$PDF" 2>&1 | tail -3

cp "$CLAUDE_JSON" /tmp/benchmark-gpt.json
echo "GPT result saved"
echo ""

# Compare
echo ">>> Comparing results..."
npx tsx -e "
import fs from 'fs';

const claude = JSON.parse(fs.readFileSync('/tmp/benchmark-claude.json', 'utf-8'));
const gpt = JSON.parse(fs.readFileSync('/tmp/benchmark-gpt.json', 'utf-8'));

function val(obj: any, ...path: string[]): any {
  for (const k of path) {
    if (typeof obj === 'object' && obj) obj = obj[k];
    else return null;
  }
  if (typeof obj === 'object' && obj && 'wert' in obj) return obj.wert;
  return obj;
}

function filled(v: any): boolean {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

const paths = [
  ['Name', 'schuldner', 'name'],
  ['Vorname', 'schuldner', 'vorname'],
  ['Geburtsdatum', 'schuldner', 'geburtsdatum'],
  ['Adresse', 'schuldner', 'aktuelle_adresse'],
  ['Familienstand', 'schuldner', 'familienstand'],
  ['Firma', 'schuldner', 'firma'],
  ['Rechtsform', 'schuldner', 'rechtsform'],
  ['Telefon', 'schuldner', 'telefon'],
  ['E-Mail', 'schuldner', 'email'],
  ['Betriebsstätte', 'schuldner', 'betriebsstaette_adresse'],
  ['Arbeitnehmer', 'schuldner', 'arbeitnehmer_anzahl'],
  ['Finanzamt', 'schuldner', 'finanzamt'],
  ['Steuerberater', 'schuldner', 'steuerberater'],
  ['Gericht', 'verfahrensdaten', 'gericht'],
  ['Aktenzeichen', 'verfahrensdaten', 'aktenzeichen'],
  ['Antragsdatum', 'verfahrensdaten', 'antragsdatum'],
  ['Beschlussdatum', 'verfahrensdaten', 'beschlussdatum'],
  ['Eröffnungsgrund', 'verfahrensdaten', 'eroeffnungsgrund'],
  ['Antragsart', 'verfahrensdaten', 'antragsart'],
  ['Gutachter', 'gutachterbestellung', 'gutachter_name'],
  ['Antragsteller', 'antragsteller', 'name'],
  ['Gesamtforderung', 'forderungen', 'gesamtforderungen'],
];

let cScore = 0, gScore = 0;
console.log('Field                Claude                    GPT-5.4');
console.log('='.repeat(75));

for (const [label, ...path] of paths) {
  const c = val(claude, ...path);
  const g = val(gpt, ...path);
  const cOk = filled(c);
  const gOk = filled(g);
  if (cOk) cScore++;
  if (gOk) gScore++;
  const cStr = (cOk ? 'Y' : 'X') + ' ' + String(c || '').slice(0, 22);
  const gStr = (gOk ? 'Y' : 'X') + ' ' + String(g || '').slice(0, 22);
  console.log('  ' + String(label).padEnd(18) + cStr.padEnd(26) + gStr);
}

console.log('='.repeat(75));
console.log('  SCORE'.padEnd(20) + ('Claude: ' + cScore + '/' + paths.length).padEnd(26) + 'GPT: ' + gScore + '/' + paths.length);

const cEf = claude.forderungen?.einzelforderungen?.length || 0;
const gEf = gpt.forderungen?.einzelforderungen?.length || 0;
const cAk = claude.aktiva?.positionen?.length || 0;
const gAk = gpt.aktiva?.positionen?.length || 0;
console.log('');
console.log('  Einzelforderungen: Claude=' + cEf + '  GPT=' + gEf);
console.log('  Aktiva:            Claude=' + cAk + '  GPT=' + gAk);
"
