import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import { config } from '../config';
import { extractionResultSchema } from '../utils/validation';
import { logger } from '../utils/logger';
import { parallelLimitSettled } from '../utils/parallel';
import { detectProvider, supportsNativePdf as providerSupportsNativePdf, getAnthropicClient, getVertexClient } from './extractionProvider';
import type { DocumentSegment } from '../utils/documentAnalyzer';
import type { ExtractionResult, Standardanschreiben, FehlendInfo } from '../types/extraction';

// Use the provider layer's client — works for direct, Vertex, and Langdock
export const anthropic = getAnthropicClient();

// Detect rate-limited providers
import { isRateLimited } from './extractionProvider';
const isRateLimitedProvider = (): boolean => isRateLimited(detectProvider());

// Delay between API calls for rate-limited providers (wait for TPM window to reset)
const RATE_LIMITED_DELAY_MS = 62_000; // 62s — just over 1 minute TPM window

// Max pages per document-aware chunk (soft limit — won't split a document)
const MAX_PAGES_PER_CHUNK = 40;
// Fallback: 30 pages per chunk when no segments available
const FALLBACK_PAGES_PER_CHUNK = 30;
// Concurrency limit for parallel extraction chunks
const EXTRACTION_CONCURRENCY = 3;
// 65s wait before retrying after a 429
const RATE_LIMIT_RETRY_DELAY_MS = 65_000;

// NOTE: Structured Output (output_config / json_schema) removed intentionally.
// The API-level schema conflicted with the prompt's {wert,quelle} pattern,
// causing Claude to produce inconsistent output. We rely on:
// 1. Clear prompt with exact JSON example
// 2. Robust Zod validation with z.preprocess coercion at every level
// 3. jsonrepair for minor JSON syntax issues
// This combination is more reliable than API-enforced schemas.

// ─── Shared Extraction Prompt ───

export const EXTRACTION_PROMPT = `Du bist ein spezialisierter KI-Assistent für deutsche Insolvenzverwalter. Analysiere die hochgeladene Gerichtsakte und extrahiere ALLE relevanten Informationen strukturiert.

PFLICHT: Jedes Feld mit ausgefülltem "wert" MUSS eine "quelle" haben. Ohne Quelle ist die Extraktion unbrauchbar. Die quelle MUSS die exakte Fundstelle angeben: die Seite, auf der du den Wert im vorliegenden Akteninhalt gefunden hast. Format: "Seite X, [Dokument/Abschnitt]". Beispiele: "Seite 1, Beschluss vom 18.12.2025", "Seite 3, Insolvenzantrag der HEK", "Seite 7, Mitteilung des Gerichtsvollziehers". Regel: wert nicht leer → quelle nicht leer.
WICHTIG — zustellungsdatum_schuldner: Das Zustellungsdatum ist das Datum auf der POSTZUSTELLUNGSURKUNDE (PZU, gelbe Zustellungsurkunde) oder dem Zustellvermerk — NICHT das Datum des zugestellten Schreibens. Suche nach dem Stempel "Datum" auf der PZU, dem handschriftlichen Datum im Zustellvermerk, oder "Erledigt... Datum:" auf der Zustellungsurkunde. Beispiel: Schreiben datiert 27.11.2025, PZU-Stempel zeigt 03.12.2025 → zustellungsdatum = 03.12.2025.
WICHTIG: Die quelle muss die tatsächliche Fundstelle sein — die Seite, auf der du den Wert im vorliegenden Dokument gefunden hast. Bei textbasiertem Akteninhalt mit "=== SEITE X ===": genau diese X verwenden. Bei PDF: verwende die POSITION der Seite im PDF (1 = erste Seite des PDFs, 2 = zweite Seite, etc.). NICHT die aufgedruckte Seitenzahl ("Seite 5 von 32" im Fußbereich) verwenden — diese ist die interne Nummerierung des Einzeldokuments und stimmt NICHT mit der PDF-Seitenposition überein. Beispiel: Ein Fragebogen mit aufgedruckter "Seite 3 von 32" steht vielleicht auf der 5. Seite des PDFs → quelle = "Seite 5, Fragebogen". Keine generischen oder geschätzten Quellen.
Datumsformat: TT.MM.JJJJ (z.B. 18.12.2025). Beträge: IMMER als reine Zahl ohne Tausendertrennzeichen (z.B. 100000.00 NICHT 100.000,00). NIEMALS Beträge selbst addieren oder berechnen — nur den exakten Wert aus dem Dokument übernehmen. Wenn ein Gesamtbetrag nicht explizit im Dokument steht, null setzen.

WASSERZEICHEN: Viele Gerichtsakten enthalten diagonale Wasserzeichen (z.B. Name + Datum schräg über die Seite). IGNORIERE diese komplett — sie sind KEIN Akteninhalt. Extrahiere NUR den eigentlichen Dokumenttext.

HANDSCHRIFTLICHE FORMULARE: Gerichtsakten enthalten oft handausgefüllte Fragebogen. Lies handschriftliche Einträge BESONDERS SORGFÄLTIG — sie enthalten wichtige Daten wie Telefon, E-Mail, Firma-Adresse, Steuerberater, SV-Träger, Anzahl Arbeitnehmer, Mietrückstände. Suche gezielt nach:
- Fragebogen "Allgemeine Angaben" (Telefon-Nr, E-Mail, Familienstand, Firma-Name + Adresse)
- Fragebogen "Geschäftsbetrieb" (Geschäftszweig, Mitarbeiter, Mietverhältnisse, Mietrückstände)
- "Ergänzende betriebliche Angaben" (Anschrift Geschäftsbetrieb, SV-Träger, Betriebsrat, Buchführung/Steuerberater)
- "Vermögensübersicht" (Grundstücke, Maschinen, Bankguthaben, Einkünfte)
- betriebsstaette_adresse: Die Adresse des Geschäftsbetriebs/der Firma — NICHT die Privatanschrift. Steht oft auf Anlage 2 "Angaben zum Geschäftsbetrieb".

UNTERNEHMENSDATEN (schuldner.*): Bei juristischen Personen (GmbH, AG, etc.) extrahiere zusätzlich:
- satzungssitz vs. verwaltungssitz (können abweichen), unternehmensgegenstand (aus HR-Auszug), geschaeftszweig (WZ-Klassifikation falls vorhanden)
- stammkapital, gesellschafter (Array mit {name, sitz, beteiligung}), geschaeftsfuehrer (Name, geb., § 181-Status), prokurist
- gruendungsdatum, hr_eintragung_datum, groessenklasse_hgb (z.B. "Kleine Kapitalgesellschaft, § 267 Abs. 1 HGB"), dundo_versicherung
- arbeitnehmer_anzahl, betriebsrat (true/false)
- finanzamt, steuernummer, ust_id, wirtschaftsjahr, ust_versteuerung (Soll/Ist), steuerliche_organschaft, letzter_jahresabschluss
- sozialversicherungstraeger (alle genannten SV-Träger), steuerberater (Name + Adresse), bankverbindungen (alle Konten mit IBAN/Kontonr.)
Bei natürlichen Personen: telefon, email, insolvenzsonderkonto falls vorhanden.
gesellschafter ist ein Array: [{"name": "KS Holding GmbH", "sitz": "66740 Saarlouis", "beteiligung": "39,5 %"}, ...]

Antworte AUSSCHLIESSLICH mit validem JSON (kein Markdown, keine Backticks). WICHTIG: In allen String-Werten Anführungszeichen mit \\ escapen, keine Zeilenumbrüche innerhalb von Strings. Bei Zahlen: IMMER als JSON number (z.B. 100000.00), NICHT als String, NICHT in deutschem Format. Nur 0 setzen, wenn der Wert tatsächlich 0 in der Akte steht — sonst null und quelle leer lassen. NIEMALS Beträge selbst berechnen oder addieren. Verwende folgende Struktur:

{
  "verfahrensdaten": {
    "aktenzeichen": {"wert": "", "quelle": ""},
    "gericht": {"wert": "", "quelle": ""},
    "richter": {"wert": "", "quelle": ""},
    "antragsdatum": {"wert": "", "quelle": ""},
    "beschlussdatum": {"wert": "", "quelle": ""},
    "antragsart": {"wert": "", "quelle": ""},
    "eroeffnungsgrund": {"wert": "", "quelle": ""},
    "zustellungsdatum_schuldner": {"wert": "", "quelle": ""},
    "verfahrensstadium": {"wert": "", "quelle": ""},
    "verfahrensart": {"wert": "", "quelle": ""},
    "internationaler_bezug": {"wert": false, "quelle": ""},
    "eigenverwaltung": {"wert": false, "quelle": ""}
  },
  "schuldner": {
    "name": {"wert": "", "quelle": ""},
    "vorname": {"wert": "", "quelle": ""},
    "geburtsdatum": {"wert": "", "quelle": ""},
    "geburtsort": {"wert": "", "quelle": ""},
    "geburtsland": {"wert": "", "quelle": ""},
    "staatsangehoerigkeit": {"wert": "", "quelle": ""},
    "familienstand": {"wert": "", "quelle": ""},
    "geschlecht": {"wert": "", "quelle": ""},
    "aktuelle_adresse": {"wert": "", "quelle": ""},
    "fruehere_adressen": [],
    "firma": {"wert": "", "quelle": ""},
    "rechtsform": {"wert": "", "quelle": ""},
    "betriebsstaette_adresse": {"wert": "", "quelle": ""},
    "handelsregisternummer": {"wert": "", "quelle": ""},
    "telefon": {"wert": "", "quelle": ""},
    "email": {"wert": "", "quelle": ""},
    "kinder": [],
    "satzungssitz": {"wert": "", "quelle": ""},
    "verwaltungssitz": {"wert": "", "quelle": ""},
    "unternehmensgegenstand": {"wert": "", "quelle": ""},
    "geschaeftszweig": {"wert": "", "quelle": ""},
    "stammkapital": {"wert": "", "quelle": ""},
    "gesellschafter": [],
    "geschaeftsfuehrer": {"wert": "", "quelle": ""},
    "prokurist": {"wert": "", "quelle": ""},
    "gruendungsdatum": {"wert": "", "quelle": ""},
    "hr_eintragung_datum": {"wert": "", "quelle": ""},
    "groessenklasse_hgb": {"wert": "", "quelle": ""},
    "dundo_versicherung": {"wert": "", "quelle": ""},
    "arbeitnehmer_anzahl": {"wert": 0, "quelle": ""},
    "betriebsrat": {"wert": false, "quelle": ""},
    "finanzamt": {"wert": "", "quelle": ""},
    "steuernummer": {"wert": "", "quelle": ""},
    "ust_id": {"wert": "", "quelle": ""},
    "wirtschaftsjahr": {"wert": "", "quelle": ""},
    "ust_versteuerung": {"wert": "", "quelle": ""},
    "steuerliche_organschaft": {"wert": false, "quelle": ""},
    "letzter_jahresabschluss": {"wert": "", "quelle": ""},
    "sozialversicherungstraeger": {"wert": "", "quelle": ""},
    "steuerberater": {"wert": "", "quelle": ""},
    "bankverbindungen": {"wert": "", "quelle": ""},
    "insolvenzsonderkonto": {"wert": "", "quelle": ""},
    "ehegatte": {
      "name": {"wert": "", "quelle": ""},
      "geburtsdatum": {"wert": "", "quelle": ""},
      "gueterstand": "zugewinngemeinschaft|guetertrennung|guetergemeinschaft|unbekannt",
      "gemeinsames_eigentum": {"wert": "", "quelle": ""}
    },
    "beschaeftigung": {
      "arbeitgeber": {"wert": "", "quelle": ""},
      "arbeitgeber_adresse": {"wert": "", "quelle": ""},
      "nettoeinkommen": {"wert": 0, "quelle": ""},
      "beschaeftigt_seit": {"wert": "", "quelle": ""},
      "art": {"wert": "", "quelle": ""}
    },
    "pfaendungsberechnung": {
      "nettoeinkommen": {"wert": 0, "quelle": ""},
      "unterhaltspflichten": {"wert": 0, "quelle": ""},
      "pfaendbarer_betrag": {"wert": 0, "quelle": ""}
    }
  },
  "antragsteller": {
    "name": {"wert": "", "quelle": ""},
    "adresse": {"wert": "", "quelle": ""},
    "ansprechpartner": {"wert": "", "quelle": ""},
    "telefon": {"wert": "", "quelle": ""},
    "fax": {"wert": "", "quelle": ""},
    "email": {"wert": "", "quelle": ""},
    "betriebsnummer": {"wert": "", "quelle": ""},
    "bankverbindung_iban": {"wert": "", "quelle": ""},
    "bankverbindung_bic": {"wert": "", "quelle": ""}
  },
  "forderungen": {
    "einzelforderungen": [
      {
        "glaeubiger": {"wert": "Name des Gläubigers", "quelle": ""},
        "art": "sozialversicherung|steuer|bank|lieferant|arbeitnehmer|miete|sonstige",
        "rang": "§38 Insolvenzforderung|§39 Nachrangig|Masseforderung §55",
        "betrag": {"wert": 0, "quelle": ""},
        "zeitraum_von": {"wert": "", "quelle": ""},
        "zeitraum_bis": {"wert": "", "quelle": ""},
        "titel": {"wert": "Beschreibung der Forderung", "quelle": ""},
        "sicherheit": {
          "art": "grundschuld|sicherungsuebereignung|eigentumsvorbehalt|pfandrecht|buergschaft|sonstige",
          "gegenstand": {"wert": "Beschreibung des gesicherten Gegenstands", "quelle": ""},
          "geschaetzter_wert": {"wert": 0, "quelle": ""},
          "absonderungsberechtigt": true
        },
        "ist_antragsteller": false
      }
    ],
    "gesamtforderungen": {"wert": 0, "quelle": ""},
    "gesicherte_forderungen": {"wert": 0, "quelle": ""},
    "ungesicherte_forderungen": {"wert": 0, "quelle": ""},
    "betroffene_arbeitnehmer": []
  },
  "gutachterbestellung": {
    "gutachter_name": {"wert": "", "quelle": ""},
    "gutachter_kanzlei": {"wert": "", "quelle": ""},
    "gutachter_adresse": {"wert": "", "quelle": ""},
    "gutachter_telefon": {"wert": "", "quelle": ""},
    "gutachter_email": {"wert": "", "quelle": ""},
    "abgabefrist": {"wert": "", "quelle": ""},
    "befugnisse": []
  },
  "ermittlungsergebnisse": {
    "grundbuch": {
      "ergebnis": {"wert": "", "quelle": ""},
      "grundbesitz_vorhanden": {"wert": null, "quelle": ""},
      "datum": {"wert": "", "quelle": ""}
    },
    "gerichtsvollzieher": {
      "name": {"wert": "", "quelle": ""},
      "betriebsstaette_bekannt": {"wert": null, "quelle": ""},
      "vollstreckungen": {"wert": "", "quelle": ""},
      "masse_deckend": {"wert": null, "quelle": ""},
      "vermoegensauskunft_abgegeben": {"wert": null, "quelle": ""},
      "haftbefehle": {"wert": null, "quelle": ""},
      "datum": {"wert": "", "quelle": ""}
    },
    "vollstreckungsportal": {
      "schuldnerverzeichnis_eintrag": {"wert": null, "quelle": ""},
      "vermoegensverzeichnis_eintrag": {"wert": null, "quelle": ""}
    },
    "meldeauskunft": {
      "meldestatus": {"wert": "", "quelle": ""},
      "datum": {"wert": "", "quelle": ""}
    }
  },
  "fristen": [
    {"bezeichnung": "", "datum": "", "status": "", "quelle": ""}
  ],
  "standardanschreiben": [
    {
      "typ": "",
      "empfaenger": "",
      "status": "bereit|fehlt|entfaellt",
      "begruendung": "",
      "fehlende_daten": []
    }
  ],
  "fehlende_informationen": [
    {"information": "", "grund": "", "ermittlung_ueber": ""}
  ],
  "zusammenfassung": [{"wert": "Kernpunkt der Zusammenfassung", "quelle": "Seite X, Abschnitt"}],
  "risiken_hinweise": [{"wert": "Risiko oder Hinweis", "quelle": "Seite X, Abschnitt"}],
  "aktiva": {
    "positionen": [
      {
        "beschreibung": {"wert": "Textliche Bezeichnung des Vermögenswerts (z.B. Vorräte, Sachanlagen, PKW VW Golf, Girokonto Sparkasse) — NIEMALS eine Zahl hier!", "quelle": "Seite X"},
        "geschaetzter_wert": {"wert": 0, "quelle": "Seite X"},
        "kategorie": "immobilien|fahrzeuge|bankguthaben|lebensversicherungen|wertpapiere_beteiligungen|forderungen_schuldner|bewegliches_vermoegen|geschaeftsausstattung|steuererstattungen|einkommen"
      }
    ],
    "summe_aktiva": {"wert": 0, "quelle": ""},
    "massekosten_schaetzung": {"wert": 0, "quelle": ""},
    "insolvenzanalyse": {
      "zahlungsunfaehigkeit_17": {"status": "ja|nein|offen", "begruendung": ""},
      "drohende_zahlungsunfaehigkeit_18": {"status": "ja|nein|offen", "begruendung": ""},
      "ueberschuldung_19": {"status": "ja|nein|offen", "begruendung": ""},
      "massekostendeckung_26": {"status": "ja|nein|offen", "begruendung": ""},
      "gesamtbewertung": ""
    }
  },
  "anfechtung": {
    "vorgaenge": [
      {
        "beschreibung": {"wert": "", "quelle": ""},
        "betrag": {"wert": 0, "quelle": ""},
        "datum": {"wert": "", "quelle": ""},
        "empfaenger": {"wert": "", "quelle": ""},
        "grundlage": "§130 Kongruente Deckung|§131 Inkongruente Deckung|§133 Vorsätzliche Benachteiligung|§134 Unentgeltliche Leistung|§135 Gesellschafterdarlehen",
        "risiko": "hoch|mittel|gering",
        "begruendung": "",
        "anfechtbar_ab": "",
        "ist_nahestehend": false
      }
    ],
    "gesamtpotenzial": {"wert": 0, "quelle": ""},
    "zusammenfassung": ""
  }
}

Die 10 Standardanschreiben-Typen (je ein Dokument) sind:
1. Bankenauskunft
2. Bausparkassen-Anfrage
3. Steuerberater-Kontakt
4. Strafakte-Akteneinsicht
5. KFZ-Halteranfrage Zulassungsstelle
6. Gewerbeauskunft
7. Finanzamt-Anfrage
8. KFZ-Halteranfrage KBA
9. Versicherungsanfrage
10. Gerichtsvollzieher-Anfrage

Für jeden Typ bestimme ob: "bereit" (alle Daten da, sofort generierbar), "fehlt" (Daten unvollständig), oder "entfaellt" (Anfrage nicht nötig/bereits erledigt).
WICHTIG: "bereit" NUR wenn fehlende_daten LEER ist. Bei "bereit" darf fehlende_daten keine Einträge haben.
"entfaellt" wenn: (a) bereits vom Gericht erledigt, ODER (b) der Sachverhalt nicht vorliegt (z.B. keine Fahrzeuge → KFZ-Anfragen entfallen; keine Versicherungen bekannt → Versicherungsanfrage kann trotzdem bereit sein mit generischem Empfänger).
"fehlt" wenn konkrete Daten fehlen, um den Brief zu versenden (z.B. Name der Krankenkasse, Name des Gerichtsvollziehers).
WICHTIG für empfaenger: Wenn eine konkrete Institution/Person aus der Akte bekannt ist, trage diese ein. Wenn nicht, verwende den generischen Empfänger des Typs.
Bei "fehlt" liste die fehlenden Datenfelder in fehlende_daten auf.
Bei "entfaellt" begründe warum (z.B. "Bereits vom Gericht angefragt" oder "Kein Grundvermögen vorhanden").

WICHTIG — "nicht bekannt" betrifft NUR das jeweilige Feld:
- Wenn das Dokument eine Information als unbekannt beschreibt ("ist mir nicht bekannt", "konnte nicht ermittelt werden"), setze NUR DIESES EINE FELD auf null. Alle anderen Felder im selben Abschnitt werden normal extrahiert.

Wenn eine DOKUMENTSTRUKTUR mitgegeben wird, nutze sie NUR um zu verstehen welcher Dokumentteil was enthält. Die SEITENZAHLEN in der quelle müssen von der EXAKTEN Seite kommen, auf der du den Wert im Akteninhalt findest — NICHT aus der Dokumentstruktur-Übersicht.

Extrahiere ALLE verfügbaren Daten. Bei fehlenden Informationen setze null/leere Strings und fülle fehlende_informationen mit konkreten Hinweisen, wie die Information ermittelt werden kann.
Für einzelforderungen: Erstelle für JEDE in der Akte genannte Forderung/Verbindlichkeit ein eigenes Objekt. Der Antragsteller (der den Insolvenzantrag gestellt hat) wird mit ist_antragsteller: true markiert. art: "sozialversicherung" für Krankenkassen/Rentenversicherung/Berufsgenossenschaften, "steuer" für Finanzamt/Zoll, "bank" für Banken/Sparkassen/Kreditinstitute, "lieferant" für Lieferanten/Dienstleister, "arbeitnehmer" für Lohn-/Gehaltsforderungen, "miete" für Miet-/Pachtforderungen, "sonstige" für alles andere. rang: Standard ist "§38 Insolvenzforderung". Wenn nur ein Gesamtbetrag ohne Gläubigeraufschlüsselung vorhanden ist, eine einzelne Forderung mit dem Antragsteller als Gläubiger erstellen. sicherheit: NUR angeben wenn in der Akte eine konkrete Sicherheit für diese Forderung genannt wird (z.B. Grundschuld, Sicherungsübereignung, Eigentumsvorbehalt). art der Sicherheit, Gegenstand, geschätzter Wert und ob absonderungsberechtigt. Wenn keine Sicherheit erwähnt: sicherheit weglassen. gesicherte_forderungen und ungesicherte_forderungen: Summen wenn aus der Akte ableitbar, sonst null.
WICHTIG — Forderungsdetails im titel-Feld: Wenn eine Forderung aufgeschlüsselt ist (z.B. Hauptforderung, Säumniszuschläge, Mahngebühren, Antragskosten), trage die AUFSCHLÜSSELUNG in das titel-Feld als Text ein. Beispiel: "SV-Beiträge 5.104,34 EUR + Säumniszuschläge 387,50 EUR + Mahngebühren 57,50 EUR + Antragskosten 216,00 EUR". Extrahiere auch: zeitraum_von/zeitraum_bis der Forderung (z.B. "01.11.2024" bis "31.08.2025").
ABSOLUTES VERBOT — Beträge NIEMALS selbst berechnen: Wenn eine Forderung aus Teilbeträgen besteht (z.B. Nennbetrag + Zinsen bei Wandeldarlehen, oder Hauptforderung + Nebenforderungen), setze betrag auf NULL. Trage die Komponenten NUR in das titel-Feld ein, z.B. "Wandeldarlehen: Nennbetrag 50.000,00 EUR; Zinsen 1.791,67 EUR". Die Berechnung der Summe erfolgt automatisch im System. Setze betrag NUR dann, wenn ein einzelner EXPLIZITER Gesamtbetrag im Dokument steht. NIEMALS zwei oder mehr Zahlen addieren.
WICHTIG — glaeubiger ist IMMER ein Name: Das Feld glaeubiger.wert MUSS der Name einer Person, Firma oder Organisation sein (z.B. "Huetti Ventures GmbH", "Stefan Zuschke", "Finanzamt München"). NIEMALS Beträge (z.B. "40.000,00"), Berechnungen (z.B. "751937.5") oder Datumsangaben (z.B. "05.10.2022") als Gläubigernamen eintragen. Wenn der Name des Gläubigers nicht eindeutig aus dem Dokument hervorgeht, setze glaeubiger auf null.
WICHTIG — betroffene_arbeitnehmer: Extrahiere ALLE namentlich oder zahlenmäßig genannten betroffenen Arbeitnehmer. Wenn ein Arbeitnehmer namentlich genannt wird (z.B. "für unser Mitglied Daniela-Adelina Mitache"), erstelle einen Eintrag mit anzahl: 1, typ: "Name des AN" und quelle. Auch "laufende monatliche Beiträge" in Höhe von X EUR sind ein wichtiger Hinweis — trage sie als separate Information in den Titel der Forderung ein.
Für verfahrensstadium: Erkenne aus dem Beschluss/der Akte: "Eröffnungsverfahren" (vorläufige Verwaltung angeordnet, Verfahren noch nicht eröffnet), "Eröffnetes Verfahren" (Eröffnungsbeschluss ergangen), oder "Unbekannt". Für verfahrensart: "Regelinsolvenz" (Unternehmen/Selbständige), "Verbraucherinsolvenz" (§ 304 InsO, natürliche Person ohne selbständige Tätigkeit), oder "Unbekannt".
Für ehegatte: Wenn im Insolvenzantrag oder der Vermögensauskunft ein Ehegatte/Lebenspartner genannt wird: Name, Geburtsdatum, Güterstand (oft in Vermögensauskunft oder Ehevertrag). gueterstand: "zugewinngemeinschaft" (gesetzlicher Güterstand, Standard wenn verheiratet und nichts anderes angegeben), "guetertrennung" (wenn Ehevertrag vorhanden), "guetergemeinschaft" (selten), "unbekannt". Wenn kein Ehegatte erwähnt: ehegatte weglassen.
WICHTIG — betriebsstaette_adresse vs. aktuelle_adresse: Das sind ZWEI VERSCHIEDENE Felder. aktuelle_adresse = Wohnanschrift (aus Meldeauskunft). betriebsstaette_adresse = Geschäftsadresse (aus Insolvenzantrag, Leistungsbescheid, Gewerberegister). Bei Einzelunternehmern stehen oft UNTERSCHIEDLICHE Adressen im Antrag (unter dem Firmennamen) und in der Meldeauskunft (Privatanschrift). Die Adresse im Insolvenzantrag UNTER oder NEBEN dem Firmennamen ist die Betriebsstätte, NICHT die Privatanschrift. NIEMALS die Meldeadresse als betriebsstaette_adresse verwenden wenn eine andere Adresse im Antrag steht. Beispiel: Meldeauskunft sagt "Niederstraße 118", Antrag sagt "Mehmet Bayar, Niederstraße 87, 54293 Trier, handelnd als Einzelunternehmer mit Pizza Kebaphaus" → aktuelle_adresse = Niederstraße 118, betriebsstaette_adresse = Niederstraße 87.
Für beschaeftigung: Wenn Arbeitgeber, Einkommen oder Beschäftigungsverhältnis erwähnt: Arbeitgeber Name/Adresse, Nettoeinkommen, Art (Vollzeit/Teilzeit/Minijob/Selbständig/Rentner/Arbeitslos). Wenn nicht erwähnt: beschaeftigung weglassen.
Für pfaendungsberechnung: Wenn Nettoeinkommen UND Unterhaltspflichten bekannt: Trage die Werte ein, aber berechne den pfändbaren Betrag NICHT selbst — setze pfaendbarer_betrag auf null. Die Berechnung nach § 850c ZPO Pfändungstabelle erfolgt im Frontend. Trage nur nettoeinkommen und unterhaltspflichten (Anzahl der Personen mit Unterhaltsanspruch als Zahl) aus der Akte ein. Wenn Daten fehlen: pfaendungsberechnung weglassen.
Für betroffene_arbeitnehmer: Bei Arbeitnehmerangaben Objekte mit anzahl, typ, quelle (z.B. {"anzahl":44,"typ":"Arbeitnehmer insgesamt","quelle":"Seite 7, Angaben zu Arbeitnehmerverhältnissen"}). Sonst [].
Für befugnisse: Extrahiere die konkreten Befugnisse aus dem Beschluss als Textstrings (z.B. ["Sicherungsmaßnahmen gem. § 21 InsO", "Einholung von Auskünften"]). Keine leeren Strings. Wenn keine Befugnisse im Dokument stehen, leere Liste [].

WICHTIG — Boolean-Felder (grundbesitz_vorhanden, betriebsstaette_bekannt, masse_deckend, vermoegensauskunft_abgegeben, haftbefehle, schuldnerverzeichnis_eintrag, vermoegensverzeichnis_eintrag):
- "ja" / bestätigt / vorhanden → true
- "nein" / "kein" / "keine" / "nicht vorhanden" / "hier ist kein..." / "Keine Daten gefunden" → false (NICHT null!)
- null NUR wenn die Information weder bestätigt noch verneint wird, d.h. die Ermittlung gar nicht stattgefunden hat oder das Ergebnis völlig unbekannt ist
- Beispiel: Grundbuchamt antwortet "hier ist kein Grundbesitz ersichtlich" → grundbesitz_vorhanden: false (NICHT null)
- Beispiel: Kein Grundbuchschreiben in der Akte → grundbesitz_vorhanden: null

ERINNERUNG: Jeder nicht-leere wert braucht eine quelle (Seite X, ...). Keine Ausnahme.

WICHTIG für fehlende_informationen: Jeder Eintrag MUSS ein Objekt mit allen drei Feldern sein. Das Feld "information" darf NIEMALS leer sein — trage dort stets eine kurze, prägnante Bezeichnung der fehlenden Information ein (z.B. "Beschlussdatum des Insolvenzgerichts", "Konkrete Bankverbindungen"). Keine Platzhalter wie {"information":"","grund":"..."} ausgeben. Wenn nichts fehlt, leere Liste []. Maximal 15 Einträge — nur die wichtigsten fehlenden Informationen, keine Wiederholungen.

REGELN FÜR AKTIVA (Vermögenswerte):
Identifiziere Vermögenswerte in diesen 10 Kategorien:
1. immobilien — Grundstücke, Häuser, Wohnungen (Belastungen wie Grundschulden/Hypotheken abziehen!)
2. fahrzeuge — PKW, LKW, Motorräder (Zeitwert; sicherungsübereignete kennzeichnen)
3. bankguthaben — Konten, Guthaben (beachte Pfändungsschutzkonto § 850k ZPO)
4. lebensversicherungen — Lebens-/Rentenversicherungen mit Rückkaufswert
5. wertpapiere_beteiligungen — Aktien, Fonds, GmbH-Anteile
6. forderungen_schuldner — Forderungen des Schuldners gegen Dritte
7. bewegliches_vermoegen — Schmuck, Kunst, Sammlungen (unpfändbare Haushaltsgegenstände § 811 ZPO nicht mitzählen)
8. geschaeftsausstattung — Büroausstattung, Maschinen, Warenlager
9. steuererstattungen — erwartete Steuererstattungsansprüche
10. einkommen — laufendes Einkommen (NUR pfändbarer Anteil nach § 850c ZPO, Pfändungsfreigrenzen berücksichtigen)
- Belastungen berücksichtigen: Grundschulden, Sicherungsübereignungen bei Wertermittlung abziehen
- summe_aktiva: Gesamtsumme aller Aktiva. massekosten_schaetzung: geschätzte Verfahrenskosten nach § 54 InsO
- Wenn keine Vermögenswerte gefunden: leere positionen-Liste zurückgeben
- Insolvenzanalyse: Bewerte §§ 17, 18, 19, 26 InsO separat mit "ja"/"nein"/"offen" und konkreter Begründung aus der Akte. § 19 (Überschuldung) nur bei juristischen Personen relevant — bei natürlichen Personen status="offen"

REGELN FÜR ANFECHTUNG (§§ 129-147 InsO):
Identifiziere potenziell anfechtbare Rechtshandlungen:
- § 130 Kongruente Deckung: Zahlungen auf fällige Forderungen, 3 Monate vor Antrag
- § 131 Inkongruente Deckung: Sicherungen die der Gläubiger nicht beanspruchen konnte, 3 Monate vor Antrag
- § 133 Vorsätzliche Benachteiligung: Handlungen mit Benachteiligungsvorsatz, 10 Jahre vor Antrag
- § 134 Unentgeltliche Leistung: Schenkungen und unentgeltliche Zuwendungen, 4 Jahre vor Antrag
- § 135 Gesellschafterdarlehen: Rückzahlung von Gesellschafterdarlehen, 1 Jahr vor Antrag
- § 138 InsO Nahestehende: Ehegatten, Lebenspartner, Verwandte, Gesellschafter >25%
- anfechtbar_ab: Berechne aus Antragsdatum minus Rückrechnungsfrist der jeweiligen Grundlage
- risiko: "hoch" (klare Anfechtbarkeit), "mittel" (abhängig von Beweislage), "gering" (fraglich, aber prüfenswert)
- Wenn keine anfechtbaren Vorgänge erkennbar: leere vorgaenge-Liste zurückgeben
- gesamtpotenzial: Summe aller potenziell anfechtbaren Beträge`;

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  return (
    err instanceof Anthropic.RateLimitError ||
    (err instanceof Anthropic.APIError && err.status === 429)
  );
}

const MAX_RETRIES = 3;

export async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        const delay = RATE_LIMIT_RETRY_DELAY_MS * (attempt + 1);
        logger.warn(`Rate-Limit (Versuch ${attempt + 1}/${MAX_RETRIES}). Warte ${delay / 1000}s…`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error('callWithRetry: max retries exhausted');
}

// ─── Merge ───

const ANSCHREIBEN_PRIORITY: Record<string, number> = { bereit: 3, fehlt: 2, entfaellt: 1 };

function mergeStandardanschreiben(a: Standardanschreiben[], b: Standardanschreiben[]): Standardanschreiben[] {
  const byTyp = new Map<string, Standardanschreiben>();
  for (const letter of [...a, ...b]) {
    if (!letter.typ) continue;
    const existing = byTyp.get(letter.typ);
    if (!existing) {
      byTyp.set(letter.typ, letter);
      continue;
    }
    // Merge field-by-field: keep best status AND best data from both
    const newPrio = ANSCHREIBEN_PRIORITY[letter.status] ?? 0;
    const existPrio = ANSCHREIBEN_PRIORITY[existing.status] ?? 0;
    const winningStatus = newPrio >= existPrio ? letter.status : existing.status;
    // "bereit" und "entfaellt" schließen fehlende_daten aus — nur bei "fehlt" kombinieren
    const fehlendeDaten =
      winningStatus === 'fehlt'
        ? [...new Set([...(existing.fehlende_daten || []), ...(letter.fehlende_daten || [])])]
        : [];
    const merged: Standardanschreiben = {
      typ: letter.typ,
      empfaenger: existing.empfaenger || letter.empfaenger,
      status: winningStatus,
      begruendung: (newPrio >= existPrio ? letter.begruendung : existing.begruendung) || existing.begruendung || letter.begruendung,
      fehlende_daten: fehlendeDaten,
    };
    byTyp.set(letter.typ, merged);
  }
  return Array.from(byTyp.values());
}

function mergeFehlendeInformationen(a: FehlendInfo[], b: FehlendInfo[]): FehlendInfo[] {
  const combined = [...a, ...b].filter(
    (item) => item && typeof item.information === 'string' && item.information.trim() !== ''
  );
  const byKey = new Map<string, FehlendInfo>();
  for (const item of combined) {
    const key = item.information.trim().toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      information: item.information,
      grund: item.grund || existing.grund,
      ermittlung_ueber: item.ermittlung_ueber || existing.ermittlung_ueber,
    });
  }
  return Array.from(byKey.values());
}

function mergeField(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    // Standardanschreiben: merge by Typ with status priority
    const firstItem = a[0] ?? b[0];
    if (firstItem && typeof firstItem === 'object' && 'typ' in (firstItem as object)) {
      return mergeStandardanschreiben(a as Standardanschreiben[], b as Standardanschreiben[]);
    }
    // Fehlende Informationen: merge by information, filter empty placeholders
    if (firstItem && typeof firstItem === 'object' && 'information' in (firstItem as object)) {
      return mergeFehlendeInformationen(a as FehlendInfo[], b as FehlendInfo[]);
    }
    // Einzelforderungen: deduplicate by creditor name + claim amount
    // Same creditor can have multiple distinct claims (e.g. Finanzamt with KSt + USt)
    if (firstItem && typeof firstItem === 'object' && 'glaeubiger' in (firstItem as object)) {
      const byKey = new Map<string, unknown>();
      for (const item of [...a, ...b]) {
        const obj = item as Record<string, unknown>;
        const gl = obj.glaeubiger as { wert?: unknown } | undefined;
        const name = String(gl?.wert ?? '').toLowerCase().trim();
        const betrag = (obj.betrag as { wert?: unknown })?.wert;
        const titel = String((obj.titel as { wert?: unknown })?.wert ?? '').toLowerCase().trim();
        // Composite key: creditor + amount + title → preserves distinct claims from same creditor
        const key = name
          ? `${name}|${betrag ?? ''}|${titel}`
          : `_anon_${byKey.size}`;
        if (!byKey.has(key)) {
          byKey.set(key, item);
        }
      }
      return Array.from(byKey.values());
    }
    // Aktiva positionen: deduplicate by description (case-insensitive)
    if (firstItem && typeof firstItem === 'object' && 'beschreibung' in (firstItem as object) && 'kategorie' in (firstItem as object)) {
      const byDesc = new Map<string, unknown>();
      for (const item of [...a, ...b]) {
        const obj = item as Record<string, unknown>;
        const desc = (obj.beschreibung as { wert?: unknown })?.wert;
        const key = String(desc ?? '').toLowerCase().trim() || `_anon_${byDesc.size}`;
        if (!byDesc.has(key)) byDesc.set(key, item);
      }
      return Array.from(byDesc.values());
    }
    // Generic arrays: deduplicate by JSON
    const seen = new Set<string>();
    const result: unknown[] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) { seen.add(key); result.push(item); }
    }
    return result;
  }
  if (a && b && typeof a === 'object' && !Array.isArray(a) && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    // {wert, quelle} field: take best value (prefer non-empty quelle when both have wert)
    if ('wert' in aObj) {
      const aW = aObj['wert'];
      const bW = (bObj as Record<string, unknown>)['wert'];
      const aEmpty = aW === null || aW === undefined || aW === '';
      const bEmpty = bW === null || bW === undefined || bW === '';
      if (aEmpty) return b;
      if (bEmpty) return a;
      const aQ = String((aObj as Record<string, unknown>).quelle ?? '').trim();
      const bQ = String((bObj as Record<string, unknown>).quelle ?? '').trim();
      return bQ && !aQ ? b : a;
    }
    // Nested object: recurse
    const result: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
    for (const key of keys) {
      result[key] = mergeField(aObj[key], bObj[key]);
    }
    return result;
  }
  // Primitives: take first non-empty
  if (a === null || a === undefined || a === '') return b;
  return a;
}

function mergeExtractionResults(results: ExtractionResult[]): ExtractionResult {
  if (results.length === 0) {
    return extractionResultSchema.parse({}) as unknown as ExtractionResult;
  }
  return results.reduce((merged, current) =>
    mergeField(merged, current) as ExtractionResult
  );
}

// ─── JSON extraction from Claude response ───

export function extractJsonFromText(text: string): string {
  // 1. Extract from ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  // 2. Fallback: strip ``` markers and trim
  const stripped = text.replace(/```json|```/g, '').trim();
  if (stripped) return stripped;
  // 3. Last resort: find outermost JSON structure (object or array)
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const lastBrace = text.lastIndexOf('}');
  const lastBracket = text.lastIndexOf(']');
  const start = firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace) ? firstBracket : firstBrace;
  const end = lastBracket >= 0 && (lastBrace < 0 || lastBracket > lastBrace) ? lastBracket : lastBrace;
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function parseAndValidateResponse(text: string): ExtractionResult {
  const jsonStr = extractJsonFromText(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    try {
      const repaired = jsonrepair(jsonStr);
      parsed = JSON.parse(repaired);
      logger.info('JSON per jsonrepair repariert');
    } catch (repairErr) {
      const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
      const sample = jsonStr.slice(0, 500);
      logger.error('JSON-Parse/Schema-Fehler', {
        error: msg,
        responseLength: text.length,
        jsonLength: jsonStr.length,
        sample: sample + (jsonStr.length > 500 ? '…' : ''),
      });
      throw new Error('Die KI-Antwort konnte nicht als JSON verarbeitet werden.');
    }
  }

  // Robust schema: z.preprocess coerces every field — safeParse should always succeed.
  // If it somehow still fails, log the issues but return the coerced data anyway.
  const result = extractionResultSchema.safeParse(parsed);
  if (result.success) {
    return result.data as unknown as ExtractionResult;
  }

  // Log the issues for debugging but DON'T throw — the data is still usable
  const issues = result.error.issues.slice(0, 10);
  logger.warn('Schema-Validierung: Abweichungen korrigiert', {
    issueCount: result.error.issues.length,
    paths: issues.map(i => `${i.path.join('.')}: ${i.message}`),
  });

  // safeParse failed but the preprocess schema should handle anything.
  // Last resort: return the parsed data directly — better partial data than empty.
  logger.warn('Schema-Validierung fehlgeschlagen, verwende geparste Rohdaten');
  return (parsed ?? {}) as ExtractionResult;
}

// ─── Document-Aware Chunking ───

interface DocumentChunk {
  /** Segments included in this chunk */
  segments: DocumentSegment[];
  /** All page numbers in this chunk (sorted) */
  pages: number[];
  /** Human-readable label of document types in this chunk */
  documentContext: string;
}

/**
 * Group document segments into chunks that keep documents together.
 *
 * Algorithm:
 * - Add segments to current chunk until page limit is exceeded
 * - Never split a single document across chunks
 * - If a single document exceeds the limit, it gets its own chunk
 */
export function buildDocumentAwareChunks(
  segments: DocumentSegment[],
  maxPagesPerChunk: number = MAX_PAGES_PER_CHUNK
): DocumentChunk[] {
  if (segments.length === 0) return [];

  const chunks: DocumentChunk[] = [];
  let currentSegments: DocumentSegment[] = [];
  let currentPages: number[] = [];

  for (const segment of segments) {
    // If adding this segment would exceed the limit and we already have content, start a new chunk
    if (currentPages.length + segment.pages.length > maxPagesPerChunk && currentPages.length > 0) {
      chunks.push(buildChunk(currentSegments));
      currentSegments = [];
      currentPages = [];
    }

    currentSegments.push(segment);
    currentPages.push(...segment.pages);
  }

  // Don't forget the last chunk
  if (currentSegments.length > 0) {
    chunks.push(buildChunk(currentSegments));
  }

  return chunks;
}

function buildChunk(segments: DocumentSegment[]): DocumentChunk {
  const allPages = segments.flatMap(s => s.pages).sort((a, b) => a - b);
  // Deduplicate pages (segments might overlap)
  const uniquePages = [...new Set(allPages)].sort((a, b) => a - b);

  const docLabels = segments
    .filter(s => s.type !== 'Sonstige Dokumente')
    .map(s => {
      const pageRange = s.pages.length === 1
        ? `Seite ${s.pages[0]}`
        : `Seiten ${s.pages[0]}-${s.pages[s.pages.length - 1]}`;
      return `${s.type} (${pageRange})`;
    });

  return {
    segments,
    pages: uniquePages,
    documentContext: docLabels.length > 0 ? docLabels.join(', ') : '',
  };
}

// ─── Claude API call ───

/**
 * Call Claude with streaming + extended thinking.
 * Streaming: required for operations >10 minutes.
 * Extended thinking: model reasons step-by-step before answering,
 * significantly improving cross-referencing and legal analysis quality.
 */
async function callClaudeStreaming(params: {
  model: string;
  max_tokens: number;
  messages: Anthropic.MessageCreateParams['messages'];
  system?: string;
  thinking?: boolean;
}): Promise<{ text: string; thinkingText?: string; usage: { input_tokens: number; output_tokens: number } }> {
  const streamParams: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: params.messages,
    // System prompt with cache_control for prompt caching
    // Cache reads cost 0.1x (90% reduction) — break-even after 2 hits within 5 min
    ...(params.system ? {
      system: [{
        type: 'text',
        text: params.system,
        cache_control: { type: 'ephemeral' },
      }],
    } : {}),
    // Note: temperature cannot be set when using extended thinking
  };

  // Extended thinking via effort parameter (replaces deprecated budget_tokens)
  // Claude dynamically decides when and how much to think
  if (params.thinking !== false) {
    streamParams.thinking = { type: 'enabled', budget_tokens: 10_000 };
  } else {
    // Without thinking: use temperature 0 for deterministic extraction
    streamParams.temperature = 0;
  }

  // Use Vertex client if configured, otherwise direct Anthropic
  const client = detectProvider() === 'vertex' ? getVertexClient() : anthropic;
  const stream = (client as unknown as Anthropic).messages.stream(streamParams as unknown as Anthropic.MessageStreamParams);
  const finalMessage = await stream.finalMessage();

  const text = finalMessage.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c: Anthropic.TextBlock) => c.text)
    .join('');

  // Extract thinking blocks for logging (not used in output)
  const thinkingText = finalMessage.content
    .filter((c) => c.type === 'thinking')
    .map((c) => (c as { type: 'thinking'; thinking: string }).thinking)
    .join('');

  if (thinkingText) {
    logger.debug('Extended thinking used', { thinkingTokens: thinkingText.length });
  }

  return { text, thinkingText: thinkingText || undefined, usage: finalMessage.usage };
}

async function callClaudeText(content: string): Promise<ExtractionResult> {
  const { text } = await callClaudeStreaming({
    model: config.EXTRACTION_MODEL,
    max_tokens: 32_000,
    messages: [{ role: 'user' as const, content }],
  });
  return parseAndValidateResponse(text);
}

// ─── Public API ───

export async function extractFromPdfBuffer(pdfBuffer: Buffer, documentMap?: string): Promise<ExtractionResult> {
  const base64 = pdfBuffer.toString('base64');
  logger.info('Starte Claude API-Aufruf mit PDF-Dokument');

  const promptText = documentMap
    ? `${EXTRACTION_PROMPT}\n\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---`
    : EXTRACTION_PROMPT;

  const { text } = await callWithRetry(() => callClaudeStreaming({
    model: config.EXTRACTION_MODEL,
    max_tokens: 32_000,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
        { type: 'text' as const, text: promptText },
      ],
    }],
  }));

  return parseAndValidateResponse(text);
}

/**
 * Comprehensive single-call extraction: base data + aktiva + anfechtung.
 * Used for PDFs up to 500 pages. Sends the entire PDF (native mode) or all
 * page texts in one API call using the EXTRACTION_MODEL.
 */
export async function extractComprehensive(
  pdfBuffer: Buffer | null,
  pageTexts: string[],
  documentMap?: string
): Promise<ExtractionResult> {
  const mapBlock = documentMap
    ? `\n\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
    : '';

  // Use EXTRACTION_PROMPT as system prompt (reduces prompt injection risk from document text)
  // Append few-shot learning hints from human corrections (if any exist)
  const fewShotSnippet = (() => {
    try {
      const { buildFewShotPromptSnippet } = require('../utils/fewShotCollector');
      return buildFewShotPromptSnippet();
    } catch { return ''; }
  })();
  const systemPrompt = EXTRACTION_PROMPT + fewShotSnippet;

  // For small-medium PDFs (<=500 pages): use native PDF mode if buffer available
  // Native PDF mode requires direct Anthropic API — proxies like Langdock don't support it
  const nativePdfSupported = providerSupportsNativePdf(detectProvider());
  if (nativePdfSupported && pdfBuffer && pageTexts.length <= 500) {
    const base64 = pdfBuffer.toString('base64');
    logger.info('Starte umfassende Extraktion (PDF-Modus)', { pages: pageTexts.length });

    const userContent = mapBlock
      ? `Analysiere dieses Dokument.${mapBlock}`
      : 'Analysiere dieses Dokument.';

    const { text, usage } = await callWithRetry(() => callClaudeStreaming({
      model: config.EXTRACTION_MODEL,
      max_tokens: 32_000,
      system: systemPrompt,
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 } },
          { type: 'text' as const, text: userContent },
        ],
      }],
    }));

    logger.info('Umfassende Extraktion abgeschlossen', {
      model: config.EXTRACTION_MODEL,
      pages: pageTexts.length,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    });

    return parseAndValidateResponse(text);
  }

  // For very large PDFs or no buffer: use text-based with all pages
  logger.info('Starte umfassende Extraktion (Text-Modus)', { pages: pageTexts.length });
  const pageBlock = pageTexts.map((t, i) => `=== SEITE ${i + 1} ===\n${t}`).join('\n\n');
  const content = `${mapBlock}\n--- AKTENINHALT (${pageTexts.length} Seiten) ---\n\n${pageBlock}`;

  const { text: respText, usage: respUsage } = await callWithRetry(() => callClaudeStreaming({
    model: config.EXTRACTION_MODEL,
    max_tokens: 32_000,
    system: systemPrompt,
    messages: [{ role: 'user' as const, content }],
  }));

  logger.info('Umfassende Extraktion abgeschlossen', {
    model: config.EXTRACTION_MODEL,
    pages: pageTexts.length,
    inputTokens: respUsage.input_tokens,
    outputTokens: respUsage.output_tokens,
  });

  return parseAndValidateResponse(respText);
}

/**
 * Extracts using document-aware chunks that keep related pages together.
 * Runs chunks in parallel for speed while preserving document coherence.
 *
 * Falls back to simple page-based chunking when no segments are available.
 */
export async function extractFromPageTexts(
  pageTexts: string[],
  documentMap?: string,
  segments?: DocumentSegment[]
): Promise<ExtractionResult> {
  const totalPages = pageTexts.length;

  // If we have segments, use document-aware chunking; otherwise fallback to fixed-size
  const chunks = segments && segments.length > 0
    ? buildDocumentAwareChunks(segments)
    : buildFallbackChunks(totalPages);

  logger.info('Extraktion Chunking', {
    totalPages,
    chunks: chunks.length,
    documentAware: !!(segments && segments.length > 0),
    pagesPerChunk: chunks.map(c => c.pages.length),
  });

  const mapBlock = documentMap
    ? `\n\n--- STRUKTURÜBERSICHT (nur zur Orientierung, KEINE Seitenzahlen hieraus verwenden) ---\n${documentMap}\n--- ENDE STRUKTURÜBERSICHT ---\n`
    : '';

  // Build extraction tasks — all use the full prompt + document map
  const tasks = chunks.map((chunk, i) => () => {
    const chunkText = chunk.pages
      .map(p => `=== SEITE ${p} ===\n${pageTexts[p - 1]}`)
      .join('\n\n');

    const docContext = chunk.documentContext
      ? `\nDiese Seiten enthalten: ${chunk.documentContext}\n`
      : '';

    const pageRange = chunk.pages.length === 1
      ? `Seite ${chunk.pages[0]}`
      : `Seiten ${chunk.pages[0]}–${chunk.pages[chunk.pages.length - 1]}`;

    const content = `${EXTRACTION_PROMPT}${mapBlock}${docContext}\n--- AKTENINHALT (${pageRange} von ${totalPages}) ---\n\n${chunkText}`;

    logger.info(`Chunk ${i + 1}/${chunks.length} gestartet (${pageRange}, ${chunk.pages.length} Seiten)`);

    return callWithRetry(() => callClaudeText(content));
  });

  // Run chunks — parallel for direct API, serial with delays for rate-limited providers
  let results: (ExtractionResult | undefined)[];
  let errors: (Error | undefined)[];

  if (isRateLimitedProvider()) {
    logger.info('Rate-limited provider: Chunks seriell mit 62s Pause');
    results = [];
    errors = [];
    for (let i = 0; i < tasks.length; i++) {
      if (i > 0) {
        logger.info(`Rate-limit Pause vor Chunk ${i + 1}/${tasks.length} (62s)`);
        await sleep(RATE_LIMITED_DELAY_MS);
      }
      try {
        results.push(await tasks[i]());
        errors.push(undefined);
      } catch (err) {
        results.push(undefined);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  } else {
    const settled = await parallelLimitSettled(tasks, EXTRACTION_CONCURRENCY);
    results = settled.results;
    errors = settled.errors;
  }

  // Log errors but continue with successful results
  const successfulResults: ExtractionResult[] = [];
  for (let i = 0; i < results.length; i++) {
    if (errors[i]) {
      logger.warn(`Chunk ${i + 1}/${chunks.length} fehlgeschlagen`, {
        error: errors[i]!.message,
        pages: chunks[i].pages.length,
      });
    } else if (results[i]) {
      successfulResults.push(results[i]!);
    }
  }

  if (successfulResults.length === 0) {
    throw new Error('Alle Extraktions-Chunks sind fehlgeschlagen');
  }

  if (errors.some(e => e !== undefined)) {
    logger.warn('Teilweise Extraktion', {
      successful: successfulResults.length,
      failed: errors.filter(e => e !== undefined).length,
    });
  }

  return mergeExtractionResults(successfulResults);
}

/**
 * Fallback chunking when no document segments are available.
 * Splits pages into fixed-size chunks (same as the old approach).
 */
function buildFallbackChunks(totalPages: number): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  for (let i = 0; i < totalPages; i += FALLBACK_PAGES_PER_CHUNK) {
    const pages: number[] = [];
    for (let p = i + 1; p <= Math.min(i + FALLBACK_PAGES_PER_CHUNK, totalPages); p++) {
      pages.push(p);
    }
    chunks.push({ segments: [], pages, documentContext: '' });
  }
  return chunks;
}

/**
 * Fallback: single-string text extraction (used when per-page extraction fails).
 */
export async function extractFromText(pdfText: string): Promise<ExtractionResult> {
  logger.info('Text-Fallback (Volltext)', { chars: pdfText.length });
  const content = `${EXTRACTION_PROMPT}\n\n--- AKTENINHALT ---\n\n${pdfText}`;
  return callWithRetry(() => callClaudeText(content));
}
