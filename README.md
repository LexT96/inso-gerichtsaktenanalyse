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

```
PDF Upload → Watermark-Entfernung → Seitentext-Extraktion
                    ↓
  Gescannt? → Azure Document Intelligence OCR
              (Text + Tabellen + Wort-Polygone → durchsuchbare Text-Ebene)
                    ↓
  Stufe 1: Dokumentstruktur-Analyse (Sonnet)
  Stufe 2a: Basis-Extraktion (Sonnet + Extended Thinking, Hybrid Bild+Text)
  Stufe 2b: Fokus-Passes parallel (Forderungen, Aktiva, Anfechtung)
            mit Tabellen-Anreicherung + Seitenbildern aus Azure DI
  Stufe 3: Semantische Verifikation + Handschrift-Extraktion
  Stufe 4: Deterministische Nachbearbeitung (keine LLM-Arithmetik)
  Stufe 5: Validierungs-Retry fuer kritische Felder
                    ↓
  Strukturiertes JSON + durchsuchbares PDF + 10 Anschreiben-Checklisten
```

**Modelle**: Claude Sonnet 4.6 via Langdock EU (DSGVO-konform, alle Daten in der EU).

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

| Methode | Pfad                 | Beschreibung                    | Auth |
|---------|----------------------|---------------------------------|------|
| POST    | `/api/auth/login`    | Benutzer-Anmeldung              | Nein |
| POST    | `/api/auth/refresh`  | Access Token erneuern           | Nein |
| POST    | `/api/extract`       | PDF hochladen & analysieren     | Ja   |
| GET     | `/api/history`       | Vergangene Extraktionen         | Ja   |
| GET     | `/api/history/:id`   | Einzelne Extraktion abrufen     | Ja   |
| GET     | `/api/health`        | Health Check                    | Nein |

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
