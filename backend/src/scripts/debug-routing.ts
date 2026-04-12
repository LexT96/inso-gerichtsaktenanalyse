#!/usr/bin/env npx tsx
/** Debug: show document segments and page routing for a PDF */
import '../env';
import fs from 'fs';
import { initDatabase } from '../db/database';
import { analyzeDocumentStructure, classifySegmentsForExtraction } from '../utils/documentAnalyzer';
import { extractTextPerPage } from '../services/pdfProcessor';

async function main() {
  initDatabase(process.env.DATABASE_PATH || './data/insolvenz.db');
  const pdfPath = process.argv[2] || '/Users/thorsten/KlareProzesse.de/TBS/insolvenz-extraktor/testdokumente/Gerichtsakte (gutes Beispiel).pdf';
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pageTexts = await extractTextPerPage(pdfBuffer);

  console.log(`\nAnalyzing ${pdfPath} (${pageTexts.length} pages)...\n`);

  const result = await analyzeDocumentStructure(pageTexts);
  if (!result) { console.log('Analysis failed'); return; }

  console.log('=== SEGMENTS ===');
  for (const seg of result.segments) {
    console.log(`  ${seg.type.padEnd(30)} | ${seg.description.substring(0, 60).padEnd(60)} | pages ${seg.pages[0]}-${seg.pages[seg.pages.length - 1]} (${seg.pages.length}p)`);
  }

  const routing = classifySegmentsForExtraction(result.segments, pageTexts.length);
  console.log('\n=== ROUTING ===');
  console.log(`  Forderungen: ${routing.forderungenPages.length} pages`);
  console.log(`  Aktiva:      ${routing.aktivaPages.length} pages`);
  console.log(`  Anfechtung:  ${routing.anfechtungPages.length} pages`);

  // Show which segments matched each domain
  const FORDERUNGEN_KEYWORDS = /forderung|gläubiger|glaub|kredit|verbindlich|darlehen|wandel|schuld|sozialversicherung|finanzamt|steuer|arbeitnehmer|lohn|gehalt|insolvenzantrag|antragsteller|tabelle|passiva/i;
  const AKTIVA_KEYWORDS = /aktiva|vermögensübersicht|vermögensverzeichnis|vermögenswert|vermögensaufstellung|grundbuch|grundstück|immobili|fahrzeug|kfz|pkw|guthaben|forderung.*schuldner|inventar|sachlage|vorräte|geschäftsausstattung|maschine|wertpapier|jahresabschluss|bilanz(?!.*prüfung)/i;
  const ANFECHTUNG_KEYWORDS = /anfechtung|zahlung|überweisung|transaktion|schenkung|gesellschafterdarlehen|nahestehend|§\s*1[3-4]\d|vorsätzlich|unentgeltlich|deckung|kongruent|inkongruent/i;

  console.log('\n=== KEYWORD MATCHES ===');
  for (const seg of result.segments) {
    const text = `${seg.type} ${seg.description}`.toLowerCase();
    const matches: string[] = [];
    if (FORDERUNGEN_KEYWORDS.test(text)) matches.push('FORD');
    if (AKTIVA_KEYWORDS.test(text)) matches.push('AKTIVA');
    if (ANFECHTUNG_KEYWORDS.test(text)) matches.push('ANFECHT');
    if (matches.length > 0) {
      // Find which specific keyword matched for AKTIVA
      const aktivaTerms = ['aktiva','vermögen','bilanz','grundbuch','grundstück','immobili','fahrzeug','kfz','pkw','konto','bank','guthaben','versicherung','inventar','anlage','sachlage','vorräte','geschäftsausstattung','maschine','wertpapier'];
      const matchedTerms = aktivaTerms.filter(t => text.includes(t));
      const detail = matchedTerms.length > 0 ? ` (matched: ${matchedTerms.join(', ')})` : '';
      console.log(`  ${seg.type.padEnd(30)} → ${matches.join(', ')}${matches.includes('AKTIVA') ? detail : ''}`);
    }
  }
}

main().catch(console.error);
