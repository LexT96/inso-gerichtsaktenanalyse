// Re-export types — duplicated from shared/ to avoid rootDir issues with tsc
export type Pruefstatus = 'bestaetigt' | 'korrigiert' | 'manuell';

export interface SourcedValue<T = string> {
  wert: T | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: Pruefstatus;
}

export interface SourcedNumber {
  wert: number | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: Pruefstatus;
}

export interface SourcedBoolean {
  wert: boolean | null;
  quelle: string;
  verifiziert?: boolean;
  pruefstatus?: Pruefstatus;
}

export interface Verfahrensdaten {
  aktenzeichen: SourcedValue;
  gericht: SourcedValue;
  richter: SourcedValue;
  antragsdatum: SourcedValue;
  beschlussdatum: SourcedValue;
  antragsart: SourcedValue;
  eroeffnungsgrund: SourcedValue;
  zustellungsdatum_schuldner: SourcedValue;
  verfahrensstadium?: SourcedValue;
  verfahrensart?: SourcedValue;
  internationaler_bezug?: SourcedBoolean;
  eigenverwaltung?: SourcedBoolean;
}

export interface Gesellschafter {
  name: string;
  sitz: string;
  beteiligung: string;
}

export interface Schuldner {
  name: SourcedValue;
  vorname: SourcedValue;
  geburtsdatum: SourcedValue;
  geburtsort: SourcedValue;
  geburtsland: SourcedValue;
  staatsangehoerigkeit: SourcedValue;
  familienstand: SourcedValue;
  geschlecht: SourcedValue;
  aktuelle_adresse: SourcedValue;
  fruehere_adressen: Array<string | SourcedValue>;
  firma: SourcedValue;
  rechtsform: SourcedValue;
  betriebsstaette_adresse: SourcedValue;
  handelsregisternummer: SourcedValue;
  kinder: Array<string | SourcedValue>;
  telefon?: SourcedValue;
  mobiltelefon?: SourcedValue;
  email?: SourcedValue;
  // Erweiterte Daten (natürliche Person)
  ehegatte?: Ehegatte;
  beschaeftigung?: Beschaeftigung;
  pfaendungsberechnung?: Pfaendungsberechnung;
  // Unternehmensdaten (juristische Person / Einzelunternehmen)
  satzungssitz?: SourcedValue;
  verwaltungssitz?: SourcedValue;
  unternehmensgegenstand?: SourcedValue;
  geschaeftszweig?: SourcedValue;
  stammkapital?: SourcedValue;
  gesellschafter?: Gesellschafter[];
  geschaeftsfuehrer?: SourcedValue;
  prokurist?: SourcedValue;
  gruendungsdatum?: SourcedValue;
  hr_eintragung_datum?: SourcedValue;
  groessenklasse_hgb?: SourcedValue;
  dundo_versicherung?: SourcedValue;
  arbeitnehmer_anzahl?: SourcedNumber;
  betriebsrat?: SourcedBoolean;
  // Steuerliche Angaben
  finanzamt?: SourcedValue;
  steuernummer?: SourcedValue;
  ust_id?: SourcedValue;
  wirtschaftsjahr?: SourcedValue;
  ust_versteuerung?: SourcedValue;
  steuerliche_organschaft?: SourcedBoolean;
  letzter_jahresabschluss?: SourcedValue;
  // Sonstige
  sozialversicherungstraeger?: SourcedValue;
  steuerberater?: SourcedValue;
  bankverbindungen?: SourcedValue;
  insolvenzsonderkonto?: SourcedValue;
}

export interface Antragsteller {
  name: SourcedValue;
  adresse: SourcedValue;
  ansprechpartner: SourcedValue;
  telefon: SourcedValue;
  fax: SourcedValue;
  email: SourcedValue;
  betriebsnummer: SourcedValue;
  bankverbindung_iban: SourcedValue;
  bankverbindung_bic: SourcedValue;
}

export interface ArbeitnehmerInfo {
  anzahl: number;
  typ: string;
  quelle: string;
}

export type ForderungsArt =
  | 'sozialversicherung' | 'steuer' | 'bank' | 'lieferant'
  | 'arbeitnehmer' | 'miete' | 'sonstige';

export type ForderungsRang =
  | '§38 Insolvenzforderung' | '§39 Nachrangig' | 'Masseforderung §55';

export type SicherheitArt =
  | 'grundschuld' | 'sicherungsuebereignung' | 'eigentumsvorbehalt'
  | 'pfandrecht' | 'buergschaft' | 'sonstige';

export interface Sicherheit {
  art: SicherheitArt;
  gegenstand: SourcedValue;
  geschaetzter_wert: SourcedNumber;
  absonderungsberechtigt: boolean;
}

export interface Einzelforderung {
  glaeubiger: SourcedValue;
  art: ForderungsArt;
  rang: ForderungsRang;
  betrag: SourcedNumber;
  zeitraum_von: SourcedValue;
  zeitraum_bis: SourcedValue;
  titel: SourcedValue;
  sicherheit?: Sicherheit;
  ist_antragsteller?: boolean;
}

export interface Forderungen {
  einzelforderungen: Einzelforderung[];
  gesamtforderungen: SourcedNumber;
  gesicherte_forderungen: SourcedNumber;
  ungesicherte_forderungen: SourcedNumber;
  hauptforderung_beitraege?: SourcedNumber;
  saeumniszuschlaege?: SourcedNumber;
  mahngebuehren?: SourcedNumber;
  vollstreckungskosten?: SourcedNumber;
  antragskosten?: SourcedNumber;
  gesamtforderung?: SourcedNumber;
  zeitraum_von?: SourcedValue;
  zeitraum_bis?: SourcedValue;
  laufende_monatliche_beitraege?: SourcedNumber;
  betroffene_arbeitnehmer: Array<string | ArbeitnehmerInfo | { wert?: string; name?: string }>;
}

export interface Gutachterbestellung {
  gutachter_name: SourcedValue;
  gutachter_kanzlei: SourcedValue;
  gutachter_adresse: SourcedValue;
  gutachter_telefon: SourcedValue;
  gutachter_email: SourcedValue;
  abgabefrist: SourcedValue;
  befugnisse: string[];
}

export interface Ermittlungsergebnisse {
  grundbuch: {
    ergebnis: SourcedValue;
    grundbesitz_vorhanden: SourcedBoolean;
    datum: SourcedValue;
  };
  gerichtsvollzieher: {
    name: SourcedValue;
    betriebsstaette_bekannt: SourcedBoolean;
    vollstreckungen: SourcedValue;
    masse_deckend: SourcedBoolean;
    vermoegensauskunft_abgegeben: SourcedBoolean;
    haftbefehle: SourcedBoolean;
    datum: SourcedValue;
  };
  vollstreckungsportal: {
    schuldnerverzeichnis_eintrag: SourcedBoolean;
    vermoegensverzeichnis_eintrag: SourcedBoolean;
  };
  meldeauskunft: {
    meldestatus: SourcedValue;
    datum: SourcedValue;
  };
}

export interface Frist {
  bezeichnung: string;
  datum: string;
  status: string;
  quelle: string;
}

export type AnschreibenStatus = 'bereit' | 'fehlt' | 'entfaellt';

export interface Standardanschreiben {
  typ: string;
  empfaenger: string;
  status: AnschreibenStatus;
  begruendung: string;
  fehlende_daten: string[];
}

export interface FehlendInfo {
  information: string;
  grund: string;
  ermittlung_ueber: string;
}

export type AktivaKategorie =
  | 'immobilien'
  | 'fahrzeuge'
  | 'bankguthaben'
  | 'lebensversicherungen'
  | 'wertpapiere_beteiligungen'
  | 'forderungen_schuldner'
  | 'bewegliches_vermoegen'
  | 'geschaeftsausstattung'
  | 'steuererstattungen'
  | 'einkommen';

export interface Aktivum {
  beschreibung: SourcedValue;
  geschaetzter_wert: SourcedNumber;
  kategorie: AktivaKategorie;
  liquidationswert?: SourcedNumber;
  fortfuehrungswert?: SourcedNumber;
  absonderung?: SourcedNumber;
  aussonderung?: SourcedNumber;
  freie_masse?: SourcedNumber;
  sicherungsrechte?: string;
}

export type InsolvenzgrundStatus = 'ja' | 'nein' | 'offen';

export interface InsolvenzgrundBewertung {
  status: InsolvenzgrundStatus;
  begruendung: string;
}

export interface Insolvenzanalyse {
  zahlungsunfaehigkeit_17: InsolvenzgrundBewertung;
  drohende_zahlungsunfaehigkeit_18: InsolvenzgrundBewertung;
  ueberschuldung_19: InsolvenzgrundBewertung;
  massekostendeckung_26: InsolvenzgrundBewertung;
  gesamtbewertung: string;
}

export interface AktivaAnalyse {
  positionen: Aktivum[];
  summe_aktiva: SourcedNumber;
  massekosten_schaetzung: SourcedNumber;
  insolvenzanalyse?: Insolvenzanalyse;
}

// ─── Feature: Anfechtungsanalyse (§§ 129-147 InsO) ───

export type AnfechtungsGrundlage =
  | '§130 Kongruente Deckung'
  | '§131 Inkongruente Deckung'
  | '§132 Unmittelbar nachteilige Rechtshandlung'
  | '§133 Vorsätzliche Benachteiligung'
  | '§134 Unentgeltliche Leistung'
  | '§135 Gesellschafterdarlehen'
  | '§142 Bargeschäft';

export type AnfechtungsRisiko = 'hoch' | 'mittel' | 'gering';

export interface AnfechtbarerVorgang {
  beschreibung: SourcedValue;
  betrag: SourcedNumber;
  datum: SourcedValue;
  empfaenger: SourcedValue;
  grundlage: AnfechtungsGrundlage;
  risiko: AnfechtungsRisiko;
  begruendung: string;
  anfechtbar_ab: string;
  ist_nahestehend: boolean;
}

export interface Anfechtungsanalyse {
  vorgaenge: AnfechtbarerVorgang[];
  gesamtpotenzial: SourcedNumber;
  zusammenfassung: string;
}

// ─── Feature: Erweiterte Schuldner-Daten ───

export type Gueterstand = 'zugewinngemeinschaft' | 'guetertrennung' | 'guetergemeinschaft' | 'unbekannt';

export interface Ehegatte {
  name: SourcedValue;
  geburtsdatum: SourcedValue;
  gueterstand: Gueterstand;
  gemeinsames_eigentum: SourcedValue;
}

export interface Beschaeftigung {
  arbeitgeber: SourcedValue;
  arbeitgeber_adresse: SourcedValue;
  nettoeinkommen: SourcedNumber;
  beschaeftigt_seit: SourcedValue;
  art: SourcedValue;
}

export interface Pfaendungsberechnung {
  nettoeinkommen: SourcedNumber;
  unterhaltspflichten: SourcedNumber;
  pfaendbarer_betrag: SourcedNumber;
}

export interface ExtractionResult {
  verfahrensdaten: Verfahrensdaten;
  schuldner: Schuldner;
  antragsteller: Antragsteller;
  forderungen: Forderungen;
  gutachterbestellung: Gutachterbestellung;
  ermittlungsergebnisse: Ermittlungsergebnisse;
  fristen: Frist[];
  standardanschreiben: Standardanschreiben[];
  fehlende_informationen: FehlendInfo[];
  zusammenfassung: SourcedValue[];
  risiken_hinweise: SourcedValue[];
  aktiva?: AktivaAnalyse;
  anfechtung?: Anfechtungsanalyse;
}
