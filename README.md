# TBS Aktenanalyse

KI-gestütztes Werkzeug für die Insolvenzverwalter-Kanzlei Prof. Dr. Dr. Thomas B. Schmidt. Analysiert Gerichtsakten (PDF) mittels Claude AI und extrahiert strukturiert alle verfahrensrelevanten Daten — inklusive Quellenangaben, Forderungsaufstellungen, Gutachten-Generierung und automatischer Prüfung der 10 Standardanschreiben.

**Benchmark** (Eilers, 76 Seiten, gescannt): 46/54 Felder (85%), 57 Forderungen, 9 Anfechtungsvorgaenge.

## Voraussetzungen

- **Docker** & **Docker Compose** (empfohlen)
- Oder: **Node.js 20+** + **Python 3** (mit pymupdf) für Entwicklung ohne Docker
- **Anthropic API Key** (direkt oder via [Langdock EU](https://langdock.com))

## Schnellstart

```bash
# 1. Repository klonen
git clone <repo-url> insolvenz-extraktor
cd insolvenz-extraktor

# 2. Umgebungsvariablen konfigurieren
cp .env.example .env
# .env bearbeiten: ANTHROPIC_API_KEY, JWT_SECRET (min. 32 Zeichen),
# DEFAULT_ADMIN_PASSWORD setzen

# 3. Starten
docker compose up --build
```

Anwendung öffnen: **http://localhost:3005**

Login mit den konfigurierten Admin-Credentials (Standard-Benutzername: `admin`).

## Entwicklungsmodus (empfohlen für Debugging)

**Ohne Docker** – schnellster Weg, mit Debugger und Hot-Reload:

```bash
# Terminal 1: Backend
cd backend
npm install
npm run dev

# Terminal 2: Frontend
cd frontend
npm install
npm run dev
```

Backend: `http://localhost:3004` · Frontend: `http://localhost:3005`

**Mit Docker** – Code-Änderungen ohne Rebuild (Volume-Mounts):

```bash
docker compose -f docker-compose.dev.yml up --build
```

Nach dem ersten Build werden Änderungen in `backend/src` und `frontend/src` automatisch übernommen. `LOG_LEVEL=debug` für detaillierte Logs.

## Architektur

**Monorepo** mit drei Paketen: `backend/`, `frontend/`, `shared/`.

- **Backend**: Express + TypeScript (Port 3004), SQLite (WAL, verschluesselt)
- **Frontend**: React 18 + Vite + Tailwind CSS (Port 3005)
- **Shared**: Kanonische TypeScript-Typdefinitionen (`SourcedValue<T>`, `ExtractionResult`, etc.)

**Modelle**: Claude Sonnet 4.6 via Langdock EU (DSGVO-konform, alle Daten in der EU).

### Extraktions-Pipeline

```
PDF Upload
  │
  ├─ Watermark-Entfernung (3 Strategien: Ganzzeilen, Suffix, Kurzfragmente)
  ├─ Seitentext-Extraktion
  │
  ▼
Stufe 0 — OCR (bedingt)
  Erkennung gescannter PDFs (< 50 Zeichen/Seite im Durchschnitt)
  → Azure Document Intelligence (prebuilt-layout)
  → Text + 129 Tabellen + Wort-Polygone + Konfidenzwerte
  → Ergebnisse gecacht nach PDF-Hash (data/ocr-cache/)
  → Unsichtbare Text-Ebene fuer Suche/Highlighting im PDF-Viewer
  │
  ▼
Stufe 1 — Dokumentstruktur-Analyse
  Sonnet → Dokumentkarte + Seitenklassifizierung nach Domaene
  (forderungen / aktiva / anfechtung)
  │
  ▼
Stufe 2a — Basis-Extraktion
  Sonnet + Extended Thinking
  Langdock: Hybrid-Modus (20 Schluesselseiten-Bilder + vollstaendiger OCR-Text)
  Direkte Anthropic API: Nativer PDF-Modus
  → Skalare Felder (Schuldner, Gericht, Verfahrensdaten, etc.)
  │
  ▼
Stufe 2b — Fokussierte Passes (parallel)
  ├─ Forderungen-Extraktor: Angereicherte Texte + Tabellenstrukturen + Seitenbilder
  ├─ Aktiva-Extraktor: Angereicherte Texte + Seitenbilder
  └─ Anfechtungs-Analysator: Angereicherte Texte + Seitenbilder
  Token-Budget: Alle Seiten wenn < 450K Zeichen, sonst Keyword-Routing, Notfall-Trunkierung
  → Ueberschreibt jeweilige Abschnitte im Basis-Ergebnis
  │
  ▼
Stufe 3 — Semantische Verifikation
  Sonnet prueft skalare Felder (NICHT Array-Elemente aus Fokus-Passes)
  → Kann bestaetigen, korrigieren oder entfernen — niemals erfinden
  │
  ├─ 3b: Gezielte Nachextraktion (nur skalare Felder, nur Quellseiten)
  └─ 3c: Handschrift-Extraktion (Fragebogen-Seiten → Mini-PDF oder OCR-Text)
  │
  ▼
Stufe 4 — Deterministische Nachbearbeitung (kein LLM)
  Geschlechtserkennung, Boolean-Defaults, Arbeitnehmer-Fallback, TEUR-Parsing
  │
  ▼
Stufe 5 — Validierungs-Retry
  Prueft Aktenzeichen, Gericht, Name/Firma, Datum
  Bei fehlenden Feldern: Retry mit gezieltem Prompt auf den ersten 30 Seiten
  │
  ▼
Ergebnis
  ├─ Strukturiertes JSON mit Quellenangaben (SourcedValue pro Feld)
  ├─ Durchsuchbares PDF (mit OCR-Text-Ebene bei gescannten Dokumenten)
  ├─ 10 Standardschreiben-Generierung (DOCX aus Vorlage mit 32 FELD_*-Platzhaltern)
  └─ Gutachten-Generierung (DOCX aus Vorlage mit 90+ KI-Platzhaltern)
```

### Standardschreiben-Generierung

Aus jeder abgeschlossenen Extraktion heraus lassen sich im `Anschreiben`-Tab
alle 10 Standardbriefe (Bankenauskunft, Finanzamt, Versicherung, Gerichts-
vollzieher, Steuerberater, Strafakte, Bausparkasse, KFZ-Halter KBA/Zulas-
sungsstelle, Gewerbeauskunft) als DOCX erzeugen. Der Verwalter-Picker im
Tab matched automatisch gegen den extrahierten Bestellungsbeschluss; fällt
genau ein Profil zu, wird es vorausgewählt.

Strafakte-Akteneinsicht öffnet zusätzlich ein Modal für drei Freitext-
Felder (Person/Tatvorwurf/Gegenstand).

Admin-Bereich → `BRIEFE`-Tab erlaubt Download/Upload/Rollback der Vorlagen
(validiert `FELD_*`-Pflicht-Platzhalter pro Brieftyp).
```

### Schluesselkonzepte

- **SourcedValue-Pattern**: Jedes extrahierte Feld enthaelt `{wert, quelle, verifiziert?, pruefstatus?}`. Die Quelle referenziert die exakte Seite ("Seite X, ...").
- **Asymmetrisches Vertrauen**: Stufe 2 (Extraktor) findet und weist Werte zu. Stufe 3 (Verifizierer) kann nur bestaetigen, korrigieren oder entfernen — niemals neue Werte erfinden.
- **Prompt Caching**: Alle API-Aufrufe nutzen `cache_control: ephemeral` (5 Min. TTL, ~90% Einsparung bei Input-Tokens).
- **Rate Limiter**: Globaler Token-bewusster Semaphor. Schwere Aufrufe (> 50K Tokens) begrenzt auf `floor(TPM / 80K)` gleichzeitig.
- **Smart Streaming**: Kleine Aufrufe (< 50K Tokens) ohne Streaming (schneller), grosse Aufrufe mit Streaming (verhindert Cloudflare-Timeout).

## Extraktion verifizieren & benchmarken

```bash
cd backend

# Bestehende Extraktion aus der DB pruefen
npm run verify -- --id=1

# Neue Extraktion durchfuehren und Bericht ausgeben
npm run verify -- ../path/to/akte.pdf

# Benchmark: Extraktion + permanente Speicherung zum Modellvergleich
npm run benchmark -- ../path/to/akte.pdf
npm run benchmark:list                      # Alle Runs anzeigen
npm run benchmark:compare -- 1,2            # Zwei Runs vergleichen
```

## API-Endpunkte

| Methode | Pfad                                         | Beschreibung                                     | Auth  |
|---------|----------------------------------------------|--------------------------------------------------|-------|
| POST    | `/api/auth/login`                            | Benutzer-Anmeldung                               | Nein  |
| POST    | `/api/auth/refresh`                          | Access Token erneuern                            | Nein  |
| POST    | `/api/extract`                               | PDF hochladen & analysieren                      | Ja    |
| GET     | `/api/history`                               | Vergangene Extraktionen                          | Ja    |
| GET     | `/api/history/:id`                           | Einzelne Extraktion abrufen                      | Ja    |
| GET     | `/api/history/:id/pdf`                       | Gespeicherte PDF streamen                        | Ja    |
| PATCH   | `/api/extractions/:id/fields`                | Einzelnes Feld aktualisieren                     | Ja    |
| POST    | `/api/generate-gutachten/:id/prepare`        | Gutachten-Slots via LLM befüllen                 | Ja    |
| POST    | `/api/generate-gutachten/:id/generate`       | Gutachten-DOCX erzeugen                          | Ja    |
| POST    | `/api/generate-letter/:id/:typ`              | Standardschreiben als DOCX erzeugen              | Ja    |
| GET     | `/api/letter-templates`                      | Liste der 10 Vorlagen + Metadaten                | Ja    |
| GET     | `/api/letter-templates/:typ/download`        | Aktuelle Vorlage herunterladen                   | Ja    |
| PUT     | `/api/letter-templates/:typ`                 | Vorlage hochladen (validiert FELD_*-Pflichten)   | Admin |
| POST    | `/api/letter-templates/:typ/rollback`        | Vorlage aus `.backup.docx` wiederherstellen      | Admin |
| GET/PUT | `/api/kanzlei`                               | Kanzlei-Stammdaten lesen/schreiben               | Ja    |
| GET/PUT | `/api/kanzlei/templates/:type`               | Gutachten-Vorlage herunter-/hochladen            | Admin |
| GET     | `/api/verwalter` · `/api/sachbearbeiter`     | Profil-CRUD                                      | Ja    |
| GET     | `/api/health`                                | Health Check                                     | Nein  |

## Sicherheit

Dieses Tool verarbeitet vertrauliche Gerichtsakten. Folgende Maßnahmen sind implementiert:

- **API-Key-Schutz:** Der Anthropic API-Key verbleibt ausschließlich im Backend
- **JWT-Authentifizierung:** Access Token (15 Min.) + Refresh Token (7 Tage)
- **Rate Limiting:** Max. 10 Extraktionen/Stunde pro Benutzer
- **Audit-Log:** Jede Anmeldung und Extraktion wird protokolliert (ohne Dokumentinhalte)
- **Upload-Bereinigung:** PDFs werden nach Verarbeitung sofort vom Server gelöscht
- **Security Headers:** Helmet.js für HTTP-Security-Header
- **CORS:** Nur das konfigurierte Frontend wird zugelassen
- **Passwort-Hashing:** bcrypt mit Kostenfaktor 12

### BRAO-Hinweise

- § 43a BRAO: Verschwiegenheitspflicht — keine PDF-Inhalte in Logs
- § 2 BORA: Sorgfaltspflicht — alle Daten müssen manuell geprüft werden
- Art. 28 DSGVO: Auftragsverarbeitung — Anthropic API als Auftragsverarbeiter konfigurieren

**Für den Produktiveinsatz empfohlen:** HTTPS via Reverse Proxy (nginx/Traefik), Verschlüsselung der SQLite-Datenbank, regelmäßige Backups.

## Umgebungsvariablen

| Variable                           | Pflicht | Beschreibung                           |
|------------------------------------|---------|----------------------------------------|
| `ANTHROPIC_API_KEY`                | Ja      | Anthropic oder Langdock API-Key        |
| `ANTHROPIC_BASE_URL`               | Nein    | Langdock: `https://api.langdock.com/anthropic/eu` |
| `EXTRACTION_MODEL`                 | Nein    | Standard: `claude-sonnet-4-6`. Langdock: `claude-sonnet-4-6-default` |
| `UTILITY_MODEL`                    | Nein    | Standard: `claude-haiku-4-5-20251001`. Langdock: `claude-sonnet-4-6-default` |
| `AZURE_DOC_INTEL_ENDPOINT`         | Nein    | Azure DI Endpoint (aktiviert OCR fuer gescannte PDFs) |
| `AZURE_DOC_INTEL_KEY`              | Nein    | Azure DI Key                           |
| `JWT_SECRET`                       | Ja      | Mindestens 32 Zeichen                  |
| `DB_ENCRYPTION_KEY`                | Ja      | Mindestens 32 Zeichen (256-bit Hex empfohlen) |
| `DEFAULT_ADMIN_PASSWORD`           | Ja      | Passwort fuer initialen Admin-Account  |
| `DEFAULT_ADMIN_USERNAME`           | Nein    | Standard: `admin`                      |
| `CORS_ORIGIN`                      | Nein    | Standard: `http://localhost:3005`      |
| `LOG_LEVEL`                        | Nein    | Standard: `info`                       |

Siehe `.env.example` fuer alle Variablen inkl. Provider-Beispiele (Langdock EU, Azure AI Foundry, direkte Anthropic API).

## Lizenz

Proprietary — KlareProzesse.de fuer TBS Insolvenzverwalter. Alle Rechte vorbehalten.
