# InsolvenzAkte Extraktor

KI-gestütztes Werkzeug für deutsche Insolvenzverwalter-Kanzleien. Analysiert Gerichtsakten (PDF) mittels Claude AI und extrahiert strukturiert alle verfahrensrelevanten Daten — inklusive Quellenangaben, Forderungsaufstellungen und automatischer Prüfung der 9 Standardanschreiben.

## Voraussetzungen

- **Docker** & **Docker Compose** (empfohlen)
- Oder: **Node.js 20+** für Entwicklung ohne Docker
- **Anthropic API Key** ([console.anthropic.com](https://console.anthropic.com))

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

Anwendung öffnen: **http://localhost:3000**

Login mit den konfigurierten Admin-Credentials (Standard-Benutzername: `admin`).

## Entwicklungsmodus (ohne Docker)

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend (neues Terminal)
cd frontend
npm install
npm run dev
```

Backend: `http://localhost:3001` · Frontend: `http://localhost:3000`

## Architektur

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────┐
│    Frontend      │────▶│      Backend         │────▶│  Claude API  │
│  React + Vite    │     │  Express + TypeScript │     │  (Anthropic) │
│  Tailwind CSS    │     │                      │     └──────────────┘
│  Port 3000       │     │  JWT Auth            │
└─────────────────┘     │  Rate Limiting       │     ┌──────────────┐
                         │  Audit Logging       │────▶│   SQLite     │
                         │  Port 3001           │     │  (Datenbank) │
                         └──────────────────────┘     └──────────────┘
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
| `ANTHROPIC_API_KEY`                | Ja      | Anthropic API-Schlüssel                |
| `JWT_SECRET`                       | Ja      | Mindestens 32 Zeichen                  |
| `DEFAULT_ADMIN_PASSWORD`           | Ja      | Passwort für initialen Admin-Account   |
| `DEFAULT_ADMIN_USERNAME`           | Nein    | Standard: `admin`                      |
| `JWT_ACCESS_EXPIRY`                | Nein    | Standard: `15m`                        |
| `JWT_REFRESH_EXPIRY`               | Nein    | Standard: `7d`                         |
| `DATABASE_PATH`                    | Nein    | Standard: `./data/insolvenz.db`        |
| `UPLOAD_MAX_SIZE_MB`               | Nein    | Standard: `50`                         |
| `RATE_LIMIT_EXTRACTIONS_PER_HOUR`  | Nein    | Standard: `10`                         |
| `CORS_ORIGIN`                      | Nein    | Standard: `http://localhost:3000`      |
| `PORT`                             | Nein    | Standard: `3001`                       |
| `LOG_LEVEL`                        | Nein    | Standard: `info`                       |

## Lizenz

Proprietary — Alle Rechte vorbehalten.
