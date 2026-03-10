export interface SourcedValue<T = string> {
  wert: T | null;
  quelle: string;
  verifiziert?: boolean;
}

export interface SourcedNumber {
  wert: number;
  quelle: string;
  verifiziert?: boolean;
}

export interface SourcedBoolean {
  wert: boolean | null;
  quelle: string;
  verifiziert?: boolean;
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

export interface Forderungen {
  hauptforderung_beitraege: SourcedNumber;
  saeumniszuschlaege: SourcedNumber;
  mahngebuehren: SourcedNumber;
  vollstreckungskosten: SourcedNumber;
  antragskosten: SourcedNumber;
  gesamtforderung: SourcedNumber;
  zeitraum_von: SourcedValue;
  zeitraum_bis: SourcedValue;
  laufende_monatliche_beitraege: SourcedNumber;
  betroffene_arbeitnehmer: Array<string | { wert?: string; name?: string }>;
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
  zusammenfassung: string;
  risiken_hinweise: string[];
}

export interface ExtractionStats {
  found: number;
  missing: number;
  total: number;
}

export interface ExtractionRecord {
  id: number;
  userId: number;
  filename: string;
  fileSize: number;
  resultJson: ExtractionResult | null;
  status: 'processing' | 'completed' | 'failed';
  errorMessage: string | null;
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
  createdAt: string;
}
