/**
 * Field Pack Definitions — declarative routing + prompt configuration for
 * the anchor-based extraction pipeline.
 *
 * Each pack targets a specific subset of ExtractionResult fields from
 * specific document types. The pipeline runs the anchor pass first, then
 * executes SCALAR_PACKS in order, filtered by debtor type.
 */

import type { FieldPackDefinition } from '../types/extraction';

// ─── Pack 1: Anchor (runs first, no anchor required) ───

export const ANCHOR_PACK: FieldPackDefinition = {
  id: 'anchor_core',
  name: 'Kernidentifikatoren',
  fields: [
    // Verfahrensdaten
    'verfahrensdaten.aktenzeichen',
    'verfahrensdaten.gericht',
    'verfahrensdaten.richter',
    'verfahrensdaten.beschlussdatum',
    'verfahrensdaten.antragsdatum',
    'verfahrensdaten.antragsart',
    'verfahrensdaten.eroeffnungsgrund',
    'verfahrensdaten.verfahrensart',
    'verfahrensdaten.verfahrensstadium',
    // Schuldner identity
    'schuldner.name',
    'schuldner.vorname',
    'schuldner.firma',
    'schuldner.rechtsform',
    // Antragsteller name
    'antragsteller.name',
    // Gutachterbestellung
    'gutachterbestellung.gutachter_name',
    'gutachterbestellung.gutachter_kanzlei',
    'gutachterbestellung.gutachter_adresse',
  ],
  segmentTypes: ['beschluss', 'insolvenzantrag', 'gutachterbestellung'],
  fallbackPages: 'first_8',
  maxPages: 12,
  prompt: `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Extrahiere die Kernidentifikatoren aus den vorliegenden Dokumentenseiten.

REGELN:
- Jeder Wert MUSS direkt aus dem Text stammen — keine Schätzungen, keine Annahmen
- Datumsformat: TT.MM.JJJJ (z.B. 18.12.2025)
- Fehlende Felder: null setzen (NICHT weglassen)
- quelle-Feld: "Seite X, [kurze Beschreibung]" (z.B. "Seite 1, Beschlusskopf")
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks, keine Erklärungen`,
  requiresAnchor: false,
};

// ─── Pack 2: Zustellung & Fristen ───

export const ZUSTELLUNG_FRISTEN_PACK: FieldPackDefinition = {
  id: 'zustellung_fristen',
  name: 'Zustellung & Fristen',
  fields: [
    'verfahrensdaten.zustellungsdatum_schuldner',
    'verfahrensdaten.eigenverwaltung',
    'verfahrensdaten.internationaler_bezug',
    'gutachterbestellung.bestellungsdatum',
    'gutachterbestellung.abgabefrist',
    'gutachterbestellung.befugnisse',
    'fristen',
  ],
  segmentTypes: ['pzu', 'beschluss', 'gutachterbestellung'],
  maxPages: 15,
  prompt: `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Extrahiere Zustellungs- und Fristdaten aus den vorliegenden Dokumenten.

WICHTIG — Zustellungsdatum:
- Das zustellungsdatum_schuldner stammt AUSSCHLIESSLICH aus dem PZU-Formular (Postzustellungsurkunde) oder dem gelben Zustellungsnachweis
- Das Datum auf dem Antragsschreiben oder Beschluss ist NICHT das Zustellungsdatum
- Suche nach Stempeln, handschriftlichen Einträgen oder dem PZU-Vordruck mit "zugestellt am" / "Datum der Zustellung"
- Wenn kein PZU vorhanden: zustellungsdatum_schuldner = null

FELDER:
- zustellungsdatum_schuldner: Datum aus PZU/Zustellungsnachweis (TT.MM.JJJJ)
- eigenverwaltung: true nur wenn §270 InsO explizit erwähnt oder "Eigenverwaltung" angeordnet
- internationaler_bezug: true nur wenn ausländische Niederlassungen, COMI-Verweis oder EU-EuInsVO erwähnt
- fristen: Array aller im Beschluss oder Bestellungsschreiben genannten Fristen mit Datum

REGELN:
- Fehlende Felder: null (Boolean-Felder: null wenn nicht eindeutig bestätigt, NICHT false)
- quelle-Feld: "Seite X, [kurze Beschreibung]"
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks`,
  requiresAnchor: true,
};

// ─── Pack 3: Schuldner (persönliche Daten) ───

export const SCHULDNER_PERSONAL_PACK: FieldPackDefinition = {
  id: 'schuldner_personal',
  name: 'Schuldner (persönliche Daten)',
  fields: [
    'schuldner.geburtsdatum',
    'schuldner.geburtsort',
    'schuldner.geburtsland',
    'schuldner.staatsangehoerigkeit',
    'schuldner.geschlecht',
    'schuldner.familienstand',
    'schuldner.aktuelle_adresse',
    'schuldner.betriebsstaette_adresse',
    'schuldner.fruehere_adressen',
    'schuldner.ehegatte',
    'schuldner.kinder',
    'schuldner.telefon',
    'schuldner.mobiltelefon',
    'schuldner.email',
    'schuldner.beschaeftigung',
    'schuldner.pfaendungsberechnung',
  ],
  segmentTypes: ['meldeauskunft', 'insolvenzantrag', 'fragebogen'],
  maxPages: 20,
  prompt: `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Extrahiere persönliche Daten des Schuldners aus Meldeauskunft, Insolvenzantrag und Fragebogen.

VERSCHACHTELTE STRUKTUREN:

Ehegatte (nur wenn familienstand "verheiratet" oder "eingetragene Lebenspartnerschaft"):
{
  "name": { "wert": "Nachname, Vorname", "quelle": "Seite X, ..." },
  "geburtsdatum": { "wert": "TT.MM.JJJJ" | null, "quelle": "..." },
  "gueterstand": "zugewinngemeinschaft" | "guetertrennung" | "guetergemeinschaft" | "unbekannt",
  "gemeinsames_eigentum": { "wert": "Beschreibung" | null, "quelle": "..." }
}

Beschäftigung (aktuelles Arbeitsverhältnis):
{
  "arbeitgeber": { "wert": "Firmenname", "quelle": "Seite X, ..." },
  "arbeitgeber_adresse": { "wert": "Adresse", "quelle": "..." },
  "nettoeinkommen": { "wert": 1234.56 | null, "quelle": "..." },
  "beschaeftigt_seit": { "wert": "TT.MM.JJJJ" | null, "quelle": "..." },
  "art": { "wert": "Angestellt/Selbständig/Beamter/...", "quelle": "..." }
}

REGELN:
- fruehere_adressen: Array von Adress-Strings oder SourcedValue-Objekten
- kinder: Array — Anzahl als Zahl oder Beschreibungen ("3 Kinder", "2 minderjährig")
- Fehlende Felder: null setzen
- quelle-Feld: "Seite X, [kurze Beschreibung]" — Meldeauskunft hat Vorrang vor Antrag
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks`,
  requiresAnchor: true,
};

// ─── Pack 4: Schuldner (Unternehmensdaten) ───

export const SCHULDNER_CORPORATE_PACK: FieldPackDefinition = {
  id: 'schuldner_corporate',
  name: 'Schuldner (Unternehmensdaten)',
  fields: [
    'schuldner.handelsregisternummer',
    'schuldner.satzungssitz',
    'schuldner.verwaltungssitz',
    'schuldner.gruendungsdatum',
    'schuldner.hr_eintragung_datum',
    'schuldner.unternehmensgegenstand',
    'schuldner.geschaeftsfuehrer',
    'schuldner.prokurist',
    'schuldner.gesellschafter',
    'schuldner.stammkapital',
    'schuldner.groessenklasse_hgb',
    'schuldner.betriebsstaette_adresse',
    'schuldner.finanzamt',
    'schuldner.steuernummer',
    'schuldner.ust_id',
    'schuldner.wirtschaftsjahr',
    'schuldner.ust_versteuerung',
    'schuldner.steuerliche_organschaft',
    'schuldner.letzter_jahresabschluss',
    'schuldner.steuerberater',
    'schuldner.telefon',
    'schuldner.email',
    'schuldner.bankverbindungen',
    'schuldner.insolvenzsonderkonto',
    'schuldner.sozialversicherungstraeger',
    'schuldner.arbeitnehmer_anzahl',
    'schuldner.betriebsrat',
  ],
  segmentTypes: ['handelsregister', 'insolvenzantrag', 'fragebogen'],
  maxPages: 25,
  prompt: `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Extrahiere Unternehmensdaten des Schuldners aus Handelsregisterauszug, Insolvenzantrag und Fragebogen.

VERSCHACHTELTE STRUKTUREN:

Gesellschafter (Array — jeder Gesellschafter einzeln):
[
  {
    "name": "Müller GmbH",
    "sitz": "München",
    "beteiligung": "60%"
  },
  ...
]
- name: vollständiger Name des Gesellschafters (natürliche Person oder Firma)
- sitz: Wohnort (natürliche Person) oder Geschäftssitz (juristische Person), null wenn unbekannt
- beteiligung: Prozentsatz als String (z.B. "33,33%"), null wenn unbekannt

Bankverbindungen (SourcedValue — alle Konten als strukturierter Text):
{ "wert": "Kontonummer/IBAN Bank1; Kontonummer/IBAN Bank2", "quelle": "Seite X, ..." }
- Alle bekannten Bankkonten des Unternehmens kommasepariert im wert-Feld
- Insolvenzsonderkonto separat in insolvenzsonderkonto

REGELN:
- handelsregisternummer: Format "HRB 12345" oder "HRA 67890" (mit Prefix)
- stammkapital: Betrag als String mit Währung (z.B. "25.000,00 EUR")
- groessenklasse_hgb: "klein" | "mittel" | "groß" | null
- arbeitnehmer_anzahl: numerischer Wert (Anzahl Vollzeitstellen)
- betriebsrat: true nur wenn explizit erwähnt, null wenn unbekannt
- Fehlende Felder: null setzen
- quelle-Feld: "Seite X, [kurze Beschreibung]" — Handelsregister hat Vorrang vor Antrag
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks`,
  requiresAnchor: true,
};

// ─── Pack 5: Antragsteller (Details) ───

export const ANTRAGSTELLER_PACK: FieldPackDefinition = {
  id: 'antragsteller_detail',
  name: 'Antragsteller (Details)',
  fields: [
    'antragsteller.adresse',
    'antragsteller.ansprechpartner',
    'antragsteller.telefon',
    'antragsteller.fax',
    'antragsteller.email',
    'antragsteller.bankverbindung_iban',
    'antragsteller.bankverbindung_bic',
    'antragsteller.betriebsnummer',
  ],
  segmentTypes: ['insolvenzantrag', 'beschluss'],
  maxPages: 15,
  prompt: `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Extrahiere die Kontakt- und Bankdaten des Antragstellers (Gläubiger, der den Insolvenzantrag gestellt hat).

FELDER:
- adresse: vollständige Postanschrift des Antragstellers
- ansprechpartner: Name der zuständigen Sachbearbeiterin/des Sachbearbeiters (falls genannt)
- telefon: Telefonnummer des Antragstellers
- fax: Faxnummer des Antragstellers
- email: E-Mail-Adresse des Antragstellers
- bankverbindung_iban: IBAN-Nummer für Zahlungen an den Antragsteller
- bankverbindung_bic: BIC-Code der Bank des Antragstellers
- betriebsnummer: Betriebsnummer (bei Sozialversicherungsträgern als Antragsteller, 8-stellig)

REGELN:
- Fehlende Felder: null setzen
- quelle-Feld: "Seite X, [kurze Beschreibung]"
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks`,
  requiresAnchor: true,
};

// ─── Pack 6: Ermittlungsergebnisse ───

export const ERMITTLUNG_PACK: FieldPackDefinition = {
  id: 'ermittlungsergebnisse',
  name: 'Ermittlungsergebnisse',
  fields: [
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
  segmentTypes: ['grundbuch', 'gerichtsvollzieher', 'vollstreckungsportal', 'meldeauskunft'],
  // No fallbackPages — skip if no investigation documents found
  maxPages: 20,
  prompt: `Du bist ein Spezialist für die Analyse deutscher Insolvenzakten. Extrahiere die Ermittlungsergebnisse aus Grundbuchauszug, Gerichtsvollzieherberichten, Vollstreckungsportal und Meldeauskunft.

FELDER:
grundbuch:
- ergebnis: Zusammenfassung des Grundbuchergebnisses (z.B. "Kein Grundbesitz eingetragen", "1 Wohnimmobilie in München")
- grundbesitz_vorhanden: true wenn Grundbesitz eingetragen, false wenn explizit kein Grundbesitz, null wenn unbekannt
- datum: Datum der Grundbuchanfrage (TT.MM.JJJJ)

gerichtsvollzieher:
- name: Name des zuständigen Gerichtsvollziehers
- betriebsstaette_bekannt: true wenn Betriebsstätte bekannt/ermittelt
- vollstreckungen: Text mit laufenden oder abgeschlossenen Vollstreckungsmaßnahmen
- masse_deckend: true wenn Gerichtsvollzieher Massedeckung bestätigt hat
- vermoegensauskunft_abgegeben: true wenn eidesstattliche Versicherung/Vermögensauskunft abgegeben
- haftbefehle: true wenn Haftbefehle vorliegen
- datum: Datum des Gerichtsvollzieherberichts

vollstreckungsportal:
- schuldnerverzeichnis_eintrag: true wenn Schuldner im Schuldnerverzeichnis eingetragen
- vermoegensverzeichnis_eintrag: true wenn Vermögensverzeichnis hinterlegt

meldeauskunft:
- meldestatus: aktueller Meldestatus (z.B. "Gemeldet unter Hauptadresse", "Unbekannt verzogen", "Keine Meldung")
- datum: Datum der Meldeauskunft

REGELN:
- Boolean-Felder: null wenn nicht eindeutig aus dem Dokument erkennbar (NICHT raten)
- Fehlende Felder: null setzen
- quelle-Feld: "Seite X, [kurze Beschreibung]"
- Antworte AUSSCHLIESSLICH mit validem JSON — kein Markdown, keine Backticks`,
  requiresAnchor: true,
};

// ─── SCALAR_PACKS: execution order (packs 2-6) ───

export const SCALAR_PACKS: FieldPackDefinition[] = [
  ZUSTELLUNG_FRISTEN_PACK,
  SCHULDNER_PERSONAL_PACK,
  SCHULDNER_CORPORATE_PACK,
  ANTRAGSTELLER_PACK,
  ERMITTLUNG_PACK,
];

// ─── Debtor-type filter ───

/**
 * Returns the SCALAR_PACKS appropriate for the given debtor type.
 *
 * - natuerliche_person: skip schuldner_corporate (no company data)
 * - juristische_person / personengesellschaft: skip schuldner_personal (no personal data)
 */
export function getPacksForDebtorType(
  debtorType: 'natuerliche_person' | 'juristische_person' | 'personengesellschaft',
): FieldPackDefinition[] {
  switch (debtorType) {
    case 'natuerliche_person':
      return SCALAR_PACKS.filter((p) => p.id !== 'schuldner_corporate');
    case 'juristische_person':
    case 'personengesellschaft':
      return SCALAR_PACKS.filter((p) => p.id !== 'schuldner_personal');
    default:
      return SCALAR_PACKS;
  }
}
