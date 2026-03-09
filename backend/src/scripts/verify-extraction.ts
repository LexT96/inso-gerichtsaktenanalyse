#!/usr/bin/env npx tsx
/**
 * Verifikationsskript für die Extraktion.
 *
 * Verwendung:
 *   npx tsx src/scripts/verify-extraction.ts <pfad-zur-pdf>
 *
 * Oder mit einer bestehenden Extraktion aus der DB:
 *   npx tsx src/scripts/verify-extraction.ts --id=<extraction-id>
 *
 * Das Skript gibt einen detaillierten Bericht aus:
 * - Alle Felder mit Wert/Quelle oder "leer"
 * - Standardanschreiben-Checklisten-Status
 * - Abweichungen KI vs. Checklisten
 *
 * Für --id: Nur DB-Zugriff, .env mit DATABASE_PATH wird verwendet.
 * Für PDF: Volle Extraktion, .env mit ANTHROPIC_API_KEY etc. erforderlich.
 */

import fs from 'fs';
import path from 'path';
import { initDatabase, getDb } from '../db/database';
import { validateLettersAgainstChecklists } from '../utils/letterChecklist';
import type { ExtractionResult } from '../types/extraction';

// ─── Feldliste für den Bericht (alle SourcedValue-Felder) ───

const FELD_PFADE: { bereich: string; felder: string[] }[] = [
  {
    bereich: 'Verfahrensdaten',
    felder: [
      'verfahrensdaten.aktenzeichen',
      'verfahrensdaten.gericht',
      'verfahrensdaten.richter',
      'verfahrensdaten.antragsdatum',
      'verfahrensdaten.beschlussdatum',
      'verfahrensdaten.antragsart',
      'verfahrensdaten.eroeffnungsgrund',
      'verfahrensdaten.zustellungsdatum_schuldner',
    ],
  },
  {
    bereich: 'Schuldner',
    felder: [
      'schuldner.name',
      'schuldner.vorname',
      'schuldner.geburtsdatum',
      'schuldner.geburtsort',
      'schuldner.geburtsland',
      'schuldner.staatsangehoerigkeit',
      'schuldner.familienstand',
      'schuldner.geschlecht',
      'schuldner.aktuelle_adresse',
      'schuldner.firma',
      'schuldner.rechtsform',
      'schuldner.betriebsstaette_adresse',
      'schuldner.handelsregisternummer',
    ],
  },
  {
    bereich: 'Antragsteller',
    felder: [
      'antragsteller.name',
      'antragsteller.adresse',
      'antragsteller.ansprechpartner',
      'antragsteller.telefon',
      'antragsteller.fax',
      'antragsteller.email',
      'antragsteller.betriebsnummer',
      'antragsteller.bankverbindung_iban',
      'antragsteller.bankverbindung_bic',
    ],
  },
  {
    bereich: 'Forderungen',
    felder: [
      'forderungen.hauptforderung_beitraege',
      'forderungen.saeumniszuschlaege',
      'forderungen.mahngebuehren',
      'forderungen.vollstreckungskosten',
      'forderungen.antragskosten',
      'forderungen.gesamtforderung',
      'forderungen.zeitraum_von',
      'forderungen.zeitraum_bis',
      'forderungen.laufende_monatliche_beitraege',
    ],
  },
  {
    bereich: 'Gutachterbestellung',
    felder: [
      'gutachterbestellung.gutachter_name',
      'gutachterbestellung.gutachter_kanzlei',
      'gutachterbestellung.gutachter_adresse',
      'gutachterbestellung.gutachter_telefon',
      'gutachterbestellung.gutachter_email',
      'gutachterbestellung.abgabefrist',
    ],
  },
  {
    bereich: 'Ermittlungsergebnisse',
    felder: [
      'ermittlungsergebnisse.grundbuch.ergebnis',
      'ermittlungsergebnisse.grundbuch.grundbesitz_vorhanden',
      'ermittlungsergebnisse.grundbuch.datum',
      'ermittlungsergebnisse.gerichtsvollzieher.name',
      'ermittlungsergebnisse.gerichtsvollzieher.betriebsstaette_bekannt',
      'ermittlungsergebnisse.gerichtsvollzieher.vollstreckungen',
      'ermittlungsergebnisse.gerichtsvollzieher.masse_deckend',
      'ermittlungsergebnisse.gerichtsvollzieher.vermoegensauskunft_abgegeben',
      'ermittlungsergebnisse.gerichtsvollzieher.haftbefehle',
      'ermittlungsergebnisse.gerichtsvollzieher.datum',
      'ermittlungsergebnisse.vollstreckungsportal.schuldnerverzeichnis_eintrag',
      'ermittlungsergebnisse.vollstreckungsportal.vermoegensverzeichnis_eintrag',
      'ermittlungsergebnisse.meldeauskunft.meldestatus',
      'ermittlungsergebnisse.meldeauskunft.datum',
    ],
  },
];

function getFieldValue(result: ExtractionResult, fieldPath: string): { wert: unknown; quelle?: string } {
  const parts = fieldPath.split('.');
  let obj: unknown = result;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return { wert: undefined };
    obj = (obj as Record<string, unknown>)[part];
  }
  if (obj != null && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    return { wert: o.wert, quelle: String(o.quelle ?? '') };
  }
  return { wert: obj };
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v || '—';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  return String(v);
}

function printReport(result: ExtractionResult): void {
  const validated = validateLettersAgainstChecklists(result);

  console.log('\n' + '═'.repeat(70));
  console.log('  EXTRAKTIONS-VERIFIKATIONSBERICHT');
  console.log('═'.repeat(70));

  // 1. Feldabdeckung
  console.log('\n## 1. Feldabdeckung (Wert | Quelle)\n');
  let found = 0;
  let total = 0;

  for (const { bereich, felder } of FELD_PFADE) {
    console.log(`### ${bereich}`);
    for (const field of felder) {
      total++;
      const { wert, quelle } = getFieldValue(result, field);
      const hasVal = wert !== null && wert !== undefined && wert !== '';
      if (hasVal) found++;
      const label = field.split('.').pop() ?? field;
      const status = hasVal ? '✓' : '○';
      const valStr = formatValue(wert);
      const qStr = quelle ? ` [${quelle}]` : '';
      console.log(`  ${status} ${label}: ${valStr}${qStr}`);
    }
    console.log('');
  }

  const pct = total > 0 ? Math.round((found / total) * 100) : 0;
  console.log(`Abdeckung: ${found}/${total} Felder (${pct}%)\n`);

  // 2. Standardanschreiben
  console.log('## 2. Standardanschreiben (Checklisten-Validierung)\n');
  const letters = validated.standardanschreiben || [];
  for (const l of letters) {
    const st = l.status === 'bereit' ? '✓ bereit' : l.status === 'entfaellt' ? '○ entfällt' : '△ fehlt';
    console.log(`  ${st}  ${l.typ}`);
    console.log(`      An: ${l.empfaenger || '—'}`);
    if (l.fehlende_daten?.length) {
      console.log(`      Fehlend: ${l.fehlende_daten.join(', ')}`);
    }
    if (l.begruendung) {
      console.log(`      Begründung: ${l.begruendung}`);
    }
    console.log('');
  }

  // 3. Fehlende Informationen
  const fehlend = result.fehlende_informationen || [];
  if (fehlend.length > 0) {
    console.log('## 3. Fehlende Informationen\n');
    for (const f of fehlend) {
      console.log(`  • ${f.information}`);
      if (f.grund) console.log(`    Grund: ${f.grund}`);
      if (f.ermittlung_ueber) console.log(`    → Ermittlung: ${f.ermittlung_ueber}`);
    }
    console.log('');
  }

  // 4. Zusammenfassung
  if (result.zusammenfassung) {
    console.log('## 4. Zusammenfassung\n');
    console.log(`  ${result.zusammenfassung}\n`);
  }

  // 5. Risiken/Hinweise
  const risiken = result.risiken_hinweise || [];
  if (risiken.length > 0) {
    console.log('## 5. Risiken & Hinweise\n');
    for (const r of risiken) console.log(`  • ${r}`);
    console.log('');
  }

  console.log('═'.repeat(70) + '\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idArg = args.find((a) => a.startsWith('--id='));
  const pdfArg = args.find((a) => !a.startsWith('--'));

  if (idArg) {
    const id = parseInt(idArg.split('=')[1] ?? '', 10);
    if (Number.isNaN(id)) {
      console.error('Ungültige ID:', idArg);
      process.exit(1);
    }
    const dbPath = process.env.DATABASE_PATH || './data/insolvenz.db';
    initDatabase(dbPath);
    const db = getDb();
    const row = db.prepare('SELECT result_json FROM extractions WHERE id = ?').get(id) as
      | { result_json: string }
      | undefined;
    if (!row) {
      console.error('Extraktion nicht gefunden:', id);
      process.exit(1);
    }
    const result = JSON.parse(row.result_json) as ExtractionResult;
    console.log(`\nVerifiziere Extraktion #${id}...`);
    printReport(result);
    return;
  }

  if (pdfArg) {
    const pdfPath = path.resolve(pdfArg);
    if (!fs.existsSync(pdfPath)) {
      console.error('PDF nicht gefunden:', pdfPath);
      process.exit(1);
    }
    console.log('\nStarte Extraktion für Verifikation...');
    const { processExtraction } = await import('../services/extraction');
    const tmpPath = path.join(process.cwd(), 'uploads', `verify-${Date.now()}.pdf`);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.copyFileSync(pdfPath, tmpPath);
    try {
      const { result } = await processExtraction(
        tmpPath,
        path.basename(pdfPath),
        fs.statSync(pdfPath).size,
        1
      );
      printReport(result);
    } catch (err) {
      console.error('Extraktion fehlgeschlagen:', err);
      process.exit(1);
    }
    return;
  }

  console.log(`
Verwendung:
  npx tsx src/scripts/verify-extraction.ts <pfad-zur-pdf>
  npx tsx src/scripts/verify-extraction.ts --id=<extraction-id>

Beispiele:
  npx tsx src/scripts/verify-extraction.ts standardschreiben/Bankenanfrage.pdf
  npx tsx src/scripts/verify-extraction.ts --id=1
`);
  process.exit(1);
}

main();
