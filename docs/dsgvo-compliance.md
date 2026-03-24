# DSGVO-Konformitaetsdokumentation

## InsolvenzAkte Extraktor — Datenschutz-Folgenabschaetzung und technisch-organisatorische Massnahmen

**Version:** 1.0
**Erstellt:** 2026-03-16
**Verantwortlich:** Kanzleileitung / Datenschutzbeauftragter
**Klassifizierung:** Vertraulich — Nur fuer internen Gebrauch

---

## 1. Zweck dieses Dokuments

Dieses Dokument beschreibt die datenschutzrechtlichen Aspekte des Einsatzes der Software "InsolvenzAkte Extraktor" in einer deutschen Insolvenzrechtskanzlei. Es dokumentiert die Datenfluesse zu externen Dienstleistern, die Rechtsgrundlagen der Verarbeitung, die implementierten technisch-organisatorischen Massnahmen (TOMs) sowie den Handlungsbedarf zur Herstellung vollstaendiger DSGVO-Konformitaet.

Die Software dient der automatisierten Extraktion strukturierter Daten aus Gerichtsakten im PDF-Format mittels KI-gestuetzter Analyse (Anthropic Claude API).

---

## 2. Datenfluesse zu Anthropic (Claude API)

Die Verarbeitung personenbezogener Daten durch die Anthropic Claude API erfolgt in drei Verarbeitungsstufen. In jeder Stufe werden Dokumentinhalte — und damit potenziell personenbezogene Daten von Schuldnern, Glaeubigern und weiteren Verfahrensbeteiligten — an die Anthropic-Server uebermittelt.

### 2.1 Stufe 1 — Dokumentstrukturanalyse (`documentAnalyzer.ts`)

| Aspekt | Detail |
|---|---|
| **Zweck** | Erstellung einer Strukturuebersicht des Dokuments (welche Seiten enthalten welchen Dokumenttyp) |
| **Uebermittelte Daten** | Seitenweise extrahierter Text des gesamten PDF-Dokuments, gekuerzt auf ca. 500 Zeichen pro Seite |
| **Modell** | Claude Haiku (`claude-haiku-4-5-20251001`, konfigurierbar ueber `UTILITY_MODEL`) |
| **Datenformat** | Klartext als Nachrichteninhalt (kein Dateiupload) |
| **Umfang** | Alle Seiten des Dokuments, jeweils als Textblock mit Seitenkennung (`=== SEITE X ===`) |

**Beispielhafte personenbezogene Daten in dieser Stufe:** Schuldnername, Aktenzeichen, Glaeubigernamen, Forderungsbetraege — soweit auf den ersten 500 Zeichen jeder Seite enthalten.

### 2.2 Stufe 2 — Datenextraktion (`anthropic.ts`)

| Aspekt | Detail |
|---|---|
| **Zweck** | Vollstaendige Extraktion aller verfahrensrelevanten Datenfelder aus der Gerichtsakte |
| **Uebermittelte Daten — kleine PDFs** (unter 100 Seiten) | Vollstaendiges PDF-Dokument als Base64-kodierter Binaerinhalt im nativen Dokumentmodus der Anthropic API |
| **Uebermittelte Daten — grosse PDFs** (ab 100 Seiten) | Seitenweise extrahierter Volltext in Abschnitten zu je 30 Seiten (Chunking) |
| **Modell** | Claude Sonnet (`claude-sonnet-4-6`, konfigurierbar ueber `EXTRACTION_MODEL`) |
| **Datenformat** | Natives PDF-Dokument (Base64, `application/pdf`) bzw. Klartext bei grossen Dokumenten |
| **Zusaetzlicher Kontext** | Dokumentstrukturuebersicht aus Stufe 1 als Orientierungshilfe |

**Dies ist die datenschutzrechtlich kritischste Stufe:** Bei kleinen PDFs wird das vollstaendige Originaldokument einschliesslich aller personenbezogenen Daten, handschriftlicher Eintraege und etwaiger Anlagen an die Anthropic API uebermittelt. Bei grossen PDFs wird der vollstaendige extrahierte Seitentext uebertragen.

### 2.3 Stufe 3 — Semantische Verifizierung (`semanticVerifier.ts`)

| Aspekt | Detail |
|---|---|
| **Zweck** | Ueberpruefung und Korrektur der extrahierten Werte anhand des tatsaechlichen Dokumentinhalts |
| **Uebermittelte Daten** | Extrahierte Feldwerte mit Quellenangaben sowie die referenzierten Seitentexte (nicht alle Seiten, nur die in den Quellenangaben referenzierten) |
| **Modell** | Claude Haiku (`claude-haiku-4-5-20251001`, konfigurierbar ueber `UTILITY_MODEL`) |
| **Datenformat** | Klartext als Nachrichteninhalt |
| **Zusaetzlicher Kontext** | Dokumentstrukturuebersicht aus Stufe 1 |

**Personenbezogene Daten in dieser Stufe:** Alle erfolgreich extrahierten Werte (Namen, Adressen, Geburtsdaten, Forderungsbetraege, Bankverbindungen etc.) sowie der Originaltext der zugehoerigen Quellseiten.

### 2.4 Zusammenfassung der Datenuebermittlung

| Stufe | Datenumfang | Personenbezug |
|---|---|---|
| Stufe 1 (Analyse) | Gekuerzter Seitentext (ca. 500 Zeichen/Seite) | Mittel — Dokumenttypen und Strukturdaten |
| Stufe 2 (Extraktion) | Vollstaendiges PDF oder vollstaendiger Seitentext | **Hoch** — gesamter Akteninhalt |
| Stufe 3 (Verifizierung) | Extrahierte Werte + referenzierte Seitentexte | Hoch — alle identifizierten personenbezogenen Daten |

**Kategorien betroffener Personen:**
- Insolvenzschuldner (natuerliche Personen)
- Insolvenzglaeubiger und Antragsteller
- Weitere Verfahrensbeteiligte (Richter, Gutachter, Gerichtsvollzieher)
- Gegebenenfalls Familienangehoerige des Schuldners

**Kategorien personenbezogener Daten:**
- Personalien (Name, Geburtsdatum, Geburtsort, Staatsangehoerigkeit, Familienstand)
- Anschriften (aktuelle und fruehere Wohnsitze, Betriebsstaetten)
- Finanzdaten (Forderungsbetraege, Bankverbindungen inkl. IBAN/BIC)
- Verfahrensdaten (Aktenzeichen, Beschlussdaten, Verfahrensstand)
- Gegebenenfalls besondere Kategorien personenbezogener Daten im Sinne des Art. 9 DSGVO, soweit in der Gerichtsakte enthalten

---

## 3. Rechtsgrundlage der Datenverarbeitung

### 3.1 Verarbeitung durch die Kanzlei

Die Verarbeitung personenbezogener Daten durch die Kanzlei im Rahmen der Insolvenzverwaltung stuetzt sich auf:

- **Art. 6 Abs. 1 lit. b DSGVO** — Erfuellung eines Vertrages (Insolvenzverwalterbestellung)
- **Art. 6 Abs. 1 lit. c DSGVO** — Erfuellung rechtlicher Verpflichtungen (InsO, ZPO)
- **Art. 6 Abs. 1 lit. f DSGVO** — Berechtigtes Interesse an effizienter Aktenbearbeitung

### 3.2 Uebermittlung an Anthropic als Auftragsverarbeitung

Die Uebermittlung personenbezogener Daten an die Anthropic API stellt eine **Auftragsverarbeitung gemaess Art. 28 DSGVO** dar. Anthropic verarbeitet die Daten ausschliesslich nach Weisung des Verantwortlichen (der Kanzlei) zum Zweck der Datenextraktion.

**Voraussetzung gemaess Art. 28 Abs. 3 DSGVO:** Es ist ein **Auftragsverarbeitungsvertrag (AV-Vertrag)** mit Anthropic abzuschliessen, der mindestens folgende Regelungen enthaelt:

1. Gegenstand und Dauer der Verarbeitung
2. Art und Zweck der Verarbeitung
3. Art der personenbezogenen Daten und Kategorien betroffener Personen
4. Pflichten und Rechte des Verantwortlichen
5. Weisungsbindung des Auftragsverarbeiters
6. Vertraulichkeitsverpflichtung
7. Technisch-organisatorische Massnahmen (Art. 32 DSGVO)
8. Bedingungen fuer die Hinzuziehung von Unterauftragsverarbeitern
9. Unterstuetzung bei Betroffenenrechten
10. Loeschung oder Rueckgabe nach Beendigung der Verarbeitung
11. Kontrollrechte und Audits

### 3.3 Drittlandtransfer

Anthropic hat seinen Sitz in den USA. Die Datenuebermittlung in die USA stellt einen **Drittlandtransfer gemaess Art. 44 ff. DSGVO** dar. Zulaessige Transfermechanismen:

- **EU-US Data Privacy Framework** (Angemessenheitsbeschluss der EU-Kommission, soweit Anthropic zertifiziert ist)
- **Standardvertragsklauseln (SCCs) gemaess Art. 46 Abs. 2 lit. c DSGVO** als Rueckfalloption
- Ergaenzende Schutzmassnahmen gemaess Empfehlung des EDSA (Transfer Impact Assessment)

---

## 4. Handlungsbedarf — AV-Vertrag mit Anthropic

### 4.1 Prioritaet: HOCH

**Vor dem produktiven Einsatz des Systems mit echten Mandantendaten muss ein AV-Vertrag mit Anthropic abgeschlossen werden.**

### 4.2 Erforderliche Schritte

| Nr. | Massnahme | Verantwortlich | Status |
|---|---|---|---|
| 1 | Kontaktaufnahme mit Anthropic Sales/Legal fuer Enterprise DPA/AV-Vertrag | Kanzleileitung | **Offen** |
| 2 | Pruefung, ob Anthropic unter dem EU-US Data Privacy Framework zertifiziert ist | DSB | **Offen** |
| 3 | Abschluss eines AV-Vertrags gemaess Art. 28 DSGVO (oder Akzeptanz des Anthropic DPA) | Kanzleileitung + DSB | **Offen** |
| 4 | Vereinbarung von Standardvertragsklauseln (SCCs) als Absicherung | DSB | **Offen** |
| 5 | Durchfuehrung eines Transfer Impact Assessment (TIA) | DSB | **Offen** |
| 6 | Dokumentation im Verzeichnis der Verarbeitungstaetigkeiten (Art. 30 DSGVO) | DSB | **Offen** |
| 7 | Ergaenzung der Datenschutzerklaerung/Mandanteninformation | DSB | **Offen** |

### 4.3 Kontakt Anthropic

- **Enterprise-Anfragen:** https://www.anthropic.com/contact-sales
- **Bestehendes DPA:** Pruefung unter https://www.anthropic.com/policies (aktuelle Terms of Service und Data Processing Addendum)

---

## 5. Datenverarbeitungsumfang bei Anthropic

### 5.1 Zweckbindung

Die an die Anthropic API uebermittelten Daten werden **ausschliesslich zur Verarbeitung der jeweiligen API-Anfrage** verwendet. Es findet keine Speicherung oder Weiterverarbeitung durch Anthropic ueber die unmittelbare Anfragebearbeitung hinaus statt.

### 5.2 Kein Training auf Kundendaten

Anthropic wendet fuer kommerzielle API-Nutzung eine **Zero-Retention-Policy** an:

- API-Eingaben und -Ausgaben werden **nicht** fuer das Training von KI-Modellen verwendet
- Anthropic speichert API-Anfragen und -Antworten **nicht** dauerhaft (Zero Data Retention fuer API-Kunden)
- Es findet **kein** menschliches Review von API-Anfragen zu Trainingszwecken statt

**Wichtiger Hinweis:** Die genauen Bedingungen der Zero-Retention-Policy sind im jeweils gueltigen Anthropic API Terms of Service und Data Processing Addendum festgehalten. Diese sollten vor Produktiveinsatz geprueft und dokumentiert werden. Insbesondere koennen Ausnahmen fuer Missbrauchserkennung und Sicherheitszwecke bestehen (Trust & Safety).

### 5.3 Voruebergehende Verarbeitung

Waehrend der Verarbeitung einer API-Anfrage:

- Daten befinden sich im Arbeitsspeicher der Anthropic-Infrastruktur
- Nach Rueckgabe der Antwort werden die Daten aus dem Arbeitsspeicher entfernt
- Es erfolgt keine Persistierung auf Datentraeger zu Analysezwecken

### 5.4 Einschraenkungen

Folgende Aspekte koennen nicht durch die Kanzlei kontrolliert werden und muessen im AV-Vertrag adressiert werden:

- Voruebergehende Speicherung in Anthropic-Infrastrukturlogs (Trust & Safety)
- Einsatz von Unterauftragsverarbeitern durch Anthropic (z.B. Cloud-Infrastruktur-Anbieter)
- Geographischer Standort der verarbeitenden Server

---

## 6. Implementierte technisch-organisatorische Massnahmen (TOMs)

Die folgenden Massnahmen sind in der Anwendung implementiert, um den Schutz personenbezogener Daten gemaess Art. 32 DSGVO sicherzustellen.

### 6.1 Verschluesselung der Datenuebertragung (Transportverschluesselung)

| Massnahme | Umsetzung |
|---|---|
| **TLS-Verschluesselung (HTTPS)** | Traefik v3.2 als Reverse Proxy mit automatischer TLS-Terminierung |
| **Let's Encrypt Zertifikate** | Automatische Zertifikatsbeschaffung und -erneuerung ueber ACME-Protokoll |
| **HTTP-zu-HTTPS-Umleitung** | Erzwungene Umleitung aller HTTP-Anfragen auf HTTPS |
| **API-Kommunikation** | Anthropic API-Aufrufe erfolgen ausschliesslich ueber HTTPS (TLS 1.2+) |

**Konfiguration:** `docker-compose.yml` — Traefik-Entrypoints `web` (Port 80, Redirect) und `websecure` (Port 443, TLS).

### 6.2 Authentifizierung und Sitzungsverwaltung

| Massnahme | Umsetzung |
|---|---|
| **JWT-basierte Authentifizierung** | Kurzlebige Access Tokens (Standard: 15 Minuten) |
| **Refresh Token Rotation** | Jeder Refresh erzeugt ein neues Token, alte werden sofort invalidiert |
| **Passwort-Hashing** | bcrypt mit Cost Factor 12 |
| **Rate Limiting** | Begrenzung der Anmeldeversuche und Extraktionsanfragen pro Stunde |

**Hinweis zum aktuellen Stand:** Die Token-Uebermittlung erfolgt derzeit als JSON-Response. Die Migration auf HTTP-only Secure Cookies (kein localStorage) ist als Sicherheitshaeretungsmassnahme vorgesehen und sollte priorisiert umgesetzt werden, um XSS-basierte Token-Exfiltration auszuschliessen.

### 6.3 Speicherminimierung — Memory-Only PDF-Verarbeitung

| Massnahme | Umsetzung |
|---|---|
| **Multer Memory Storage** | PDF-Dateien werden ausschliesslich im Arbeitsspeicher verarbeitet (`multer.memoryStorage()`) |
| **Keine Festplattenpersistenz** | Hochgeladene PDF-Originale werden zu keinem Zeitpunkt auf die Festplatte geschrieben |
| **Buffer-basierte Pipeline** | Der gesamte Extraktionsprozess arbeitet auf dem im RAM gehaltenen `Buffer`-Objekt |

**Datei:** `backend/src/middleware/upload.ts` — Konfiguration des Memory Storage.

**Konsequenz:** Nach Abschluss der Extraktion und Garbage Collection durch die Node.js-Runtime befinden sich keine PDF-Originale mehr im System. In der Datenbank werden ausschliesslich die extrahierten strukturierten Daten gespeichert (`result_json`), nicht das Originaldokument.

### 6.4 Verschluesselte Datenexporte

| Massnahme | Umsetzung |
|---|---|
| **AES-256-GCM Verschluesselung** | Exportierte Extraktionsergebnisse werden mit AES-256-GCM verschluesselt |
| **Authentifizierte Verschluesselung** | GCM-Modus gewaehrleistet sowohl Vertraulichkeit als auch Integritaet der Exportdaten |

**Hinweis:** Diese Massnahme ist als Teil des Sicherheitshaertungsplans vorgesehen und befindet sich in der Umsetzung.

### 6.5 Automatische Datenloeschung (Data Retention)

| Massnahme | Umsetzung |
|---|---|
| **Konfigurierbares Aufbewahrungsfenster** | Umgebungsvariable `DATA_RETENTION_HOURS` (Standard: 72 Stunden) |
| **Automatische Bereinigung** | Stuendliche Pruefung und Loeschung abgelaufener Extraktionsdatensaetze |
| **Startup-Bereinigung** | Bei jedem Serverstart werden abgelaufene Datensaetze sofort geloescht |

**Konfiguration:** `DATA_RETENTION_HOURS=72` in `.env` bzw. `docker-compose.yml`.

**Datenschutzrechtliche Relevanz:** Gemaess dem Grundsatz der Speicherbegrenzung (Art. 5 Abs. 1 lit. e DSGVO) werden personenbezogene Daten nicht laenger als fuer den Verarbeitungszweck erforderlich gespeichert. Die Standardaufbewahrungsfrist von 72 Stunden ermoeglicht die Nachbearbeitung extrahierter Daten, ohne eine dauerhafte Datenhaltung zu erfordern.

### 6.6 Recht auf Loeschung — Art. 17 DSGVO

| Massnahme | Umsetzung |
|---|---|
| **Manuelle Loeschung** | API-Endpunkt zur gezielten Loeschung einzelner Extraktionsdatensaetze |
| **Vollstaendige Entfernung** | Loeschung umfasst das gesamte Extraktionsergebnis (`result_json`) und zugehoerige Metadaten |

**Hinweis:** Ein dedizierter DSGVO-Loeschendpunkt (Art. 17 DSGVO) ist als Teil des Sicherheitshaertungsplans vorgesehen. Bis zur Umsetzung koennen Loeschanfragen manuell ueber die Datenbank oder die automatische Retention abgedeckt werden.

### 6.7 Audit Trail — Nachvollziehbarkeit der Datenverarbeitung

| Massnahme | Umsetzung |
|---|---|
| **Audit-Log-Tabelle** | `audit_log`-Tabelle mit Benutzer-ID, Aktion, Details, IP-Adresse und Zeitstempel |
| **Protokollierte Aktionen** | Login-Vorgaenge, Extraktionsvorgaenge (Dateiname, Dateigroesse) |
| **BRAO-Konformitaet** | Log-Dateien enthalten keine Dokumentinhalte — es werden niemals PDF-Texte oder extrahierte personenbezogene Daten in die Logs geschrieben |
| **Log-Rotation** | Taegliche Rotation mit 30-Tage-Aufbewahrung, komprimierte Archive |

**Dateien:**
- `backend/src/db/migrations/001_initial.sql` — Audit-Log-Tabellenschema
- `backend/src/utils/logger.ts` — Winston-Logger mit Daily Rotate File
- `backend/src/routes/extraction.ts` — Audit-Eintrag bei jeder Extraktion
- `backend/src/routes/auth.ts` — Audit-Eintrag bei jedem Login

### 6.8 Netzwerksicherheit und Zugriffssteuerung

| Massnahme | Umsetzung |
|---|---|
| **Kein direkter Portzugriff** | Backend und Frontend sind in der Produktionskonfiguration nicht direkt von aussen erreichbar (nur ueber Traefik) |
| **Helmet Security Headers** | Automatische Setzung sicherheitsrelevanter HTTP-Header (CSP, X-Frame-Options, etc.) |
| **CORS-Beschraenkung** | Nur die konfigurierte Frontend-Domain darf API-Anfragen stellen |
| **Eingabevalidierung** | Zod-basierte Validierung aller API-Eingaben; Fail-Fast bei ungueltigen Umgebungsvariablen |

---

## 7. Verfahrensbeschreibung fuer das Verzeichnis der Verarbeitungstaetigkeiten

Die folgende Uebersicht kann als Grundlage fuer den Eintrag im Verzeichnis der Verarbeitungstaetigkeiten gemaess Art. 30 DSGVO dienen.

| Feld | Inhalt |
|---|---|
| **Bezeichnung der Verarbeitungstaetigkeit** | KI-gestuetzte Extraktion strukturierter Daten aus Insolvenzgerichtsakten |
| **Verantwortlicher** | [Kanzleiname, Adresse, Kontaktdaten] |
| **Datenschutzbeauftragter** | [Name, Kontaktdaten] |
| **Zweck der Verarbeitung** | Automatisierte Erfassung verfahrensrelevanter Daten zur Erstellung von Standardschreiben im Insolvenzverfahren |
| **Rechtsgrundlage** | Art. 6 Abs. 1 lit. b, c, f DSGVO |
| **Kategorien betroffener Personen** | Insolvenzschuldner, Glaeubiger, Antragsteller, Verfahrensbeteiligte |
| **Kategorien personenbezogener Daten** | Personalien, Anschriften, Finanzdaten (Forderungen, Bankverbindungen), Verfahrensdaten |
| **Empfaenger** | Anthropic, PBC (Auftragsverarbeiter — API-Verarbeitung) |
| **Drittlandtransfer** | USA (Anthropic) — Rechtsgrundlage: EU-US DPF / SCCs |
| **Loeschfristen** | Extraktionsdaten: 72 Stunden (konfigurierbar); Audit-Logs: 30 Tage; PDF-Originale: keine Speicherung |
| **TOMs** | Siehe Abschnitt 6 dieses Dokuments |

---

## 8. Risikobewertung

### 8.1 Identifizierte Risiken

| Risiko | Eintrittswahrscheinlichkeit | Schwere | Massnahme |
|---|---|---|---|
| Unbefugter Zugriff auf extrahierte Daten | Niedrig | Hoch | Authentifizierung, Autorisierung, automatische Loeschung |
| Datenverlust bei Uebertragung an Anthropic | Sehr niedrig | Hoch | TLS-Verschluesselung (HTTPS) |
| Unbefugte Nutzung durch Anthropic | Niedrig | Hoch | Zero-Retention-Policy, AV-Vertrag |
| XSS-basierte Token-Exfiltration | Mittel | Mittel | Helmet CSP-Header, geplante Migration auf HTTP-only Cookies |
| Zugriff auf Log-Dateien mit Metadaten | Niedrig | Niedrig | Keine Dokumentinhalte in Logs, Log-Rotation |

### 8.2 Bewertung

Unter Beruecksichtigung der implementierten und geplanten Massnahmen ist das Restrisiko fuer die Rechte und Freiheiten betroffener Personen als **vertretbar** einzustufen, **sofern** der AV-Vertrag mit Anthropic abgeschlossen und die ausstehenden Sicherheitsmassnahmen (HTTP-only Cookies, DSGVO-Loeschendpunkt, verschluesselte Exporte) umgesetzt werden.

---

## 9. Datenschutz-Folgenabschaetzung (DSFA) — Erforderlichkeit

Gemaess Art. 35 Abs. 1 DSGVO ist eine Datenschutz-Folgenabschaetzung durchzufuehren, wenn eine Verarbeitung voraussichtlich ein **hohes Risiko** fuer die Rechte und Freiheiten natuerlicher Personen zur Folge hat.

**Relevante Kriterien:**

- Systematische und umfassende Bewertung persoenlicher Aspekte natuerlicher Personen (Art. 35 Abs. 3 lit. a DSGVO) — **teilweise zutreffend** (automatisierte Datenextraktion)
- Verarbeitung besonderer Kategorien personenbezogener Daten in grossem Umfang (Art. 35 Abs. 3 lit. b DSGVO) — **potenziell zutreffend** (Gerichtsakten koennen sensitive Daten enthalten)
- Einsatz neuer Technologien (Erwaegungsgrund 91) — **zutreffend** (KI-basierte Verarbeitung)

**Empfehlung:** Es wird empfohlen, eine vollstaendige DSFA gemaess Art. 35 DSGVO durchzufuehren, bevor das System produktiv mit echten Mandantendaten eingesetzt wird. Dieses Dokument kann als Grundlage hierfuer dienen.

---

## 10. Anhang: Technische Referenzen

| Komponente | Dateipfad | Relevanz |
|---|---|---|
| Dokumentstrukturanalyse (Stufe 1) | `backend/src/utils/documentAnalyzer.ts` | Seitentext-Uebermittlung an Anthropic |
| Datenextraktion (Stufe 2) | `backend/src/services/anthropic.ts` | PDF/Text-Uebermittlung an Anthropic |
| Semantische Verifizierung (Stufe 3) | `backend/src/utils/semanticVerifier.ts` | Feldwerte und Seitentext-Uebermittlung |
| PDF-Verarbeitung (Memory-only) | `backend/src/middleware/upload.ts` | Multer Memory Storage |
| Authentifizierung und Audit | `backend/src/routes/auth.ts` | JWT, bcrypt, Audit-Log |
| Datenbank-Schema | `backend/src/db/migrations/001_initial.sql` | Audit-Log-Tabelle, Extractions-Tabelle |
| Datenretention | `backend/src/index.ts` | Automatische Bereinigung |
| Sicherheits-Header | `backend/src/index.ts` | Helmet-Middleware |
| TLS-Terminierung | `docker-compose.yml` | Traefik + Let's Encrypt |
| Konfigurationsvalidierung | `backend/src/config.ts` | Zod-basierte Env-Validierung |
