export type {
  ExtractionResult,
  ExtractionStats,
  ExtractionRecord,
  SourcedValue,
  SourcedNumber,
  SourcedBoolean,
  Verfahrensdaten,
  Schuldner,
  Gesellschafter,
  Antragsteller,
  Forderungen,
  ForderungsArt,
  ForderungsRang,
  SicherheitArt,
  Sicherheit,
  Einzelforderung,
  Gutachterbestellung,
  Ermittlungsergebnisse,
  Frist,
  Standardanschreiben,
  FehlendInfo,
  AnschreibenStatus,
  Pruefstatus,
  AktivaKategorie,
  Aktivum,
  AktivaAnalyse,
  InsolvenzgrundStatus,
  InsolvenzgrundBewertung,
  Insolvenzanalyse,
  AnfechtungsGrundlage,
  AnfechtungsRisiko,
  AnfechtbarerVorgang,
  Anfechtungsanalyse,
  Gueterstand,
  Ehegatte,
  Beschaeftigung,
  Pfaendungsberechnung,
} from '@shared/types/extraction';

export interface VerwalterProfile {
  id: number;
  name: string;
  titel: string;
  geschlecht: 'maennlich' | 'weiblich';
  diktatzeichen: string;
  sachbearbeiter_name: string;
  sachbearbeiter_email: string;
  sachbearbeiter_durchwahl: string;
  standort: string;
  anderkonto_iban: string;
  anderkonto_bank: string;
}
