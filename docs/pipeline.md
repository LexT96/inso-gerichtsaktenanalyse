# Pipeline & Branching

## Branches

| Branch | Zweck                            | Auto-Deploy                           |
|--------|----------------------------------|---------------------------------------|
| `dev`  | Default — hier arbeiten          | — (nur CI)                            |
| `main` | Prod                             | → `aktenanalyse.klareprozesse.de`     |
| `demo` | Demo (mit KlareProzesse-Kanzlei) | → `https://46-224-7-60.sslip.io`      |

Feature-Branches werden von `dev` abgezweigt und per PR nach `dev` gemergt.
`dev → main` und `main → demo` sind eigenständige Promotion-Schritte (s.u.).

## Workflow

```
feature/xyz
   │ PR
   ▼
  dev  ────► PR ────►  main  ────(manuell via GH Action)────►  demo
                        │                                       │
                        └─ Push auto-deployt prod               └─ Push auto-deployt demo
```

## Commands

**Feature-Branch anlegen:**
```bash
git checkout dev && git pull
git checkout -b feature/was-auch-immer
```

**Nach dev mergen:** PR in GitHub von `feature/xyz` → `dev`. CI muss grün sein.

**Nach main promoten (Prod-Release):** PR von `dev` → `main`. Merge → Deploy startet automatisch.

**Nach demo promoten:**
```
GitHub Actions → „Promote main → demo" → Run workflow
```
Falls Merge-Konflikte (wegen demo-only `gutachtenvorlagen/` + `kanzlei.json`):
```bash
git checkout demo && git pull
git merge origin/main   # Konflikte lokal lösen
git push origin demo
```

## Guardrails

- `main` und `demo` sind protected (kein direkter Push, PR + CI grün erforderlich)
- `dev` erlaubt direkten Push
- Squash-Merge für `dev → main`, Merge-Commit für `main → demo` (Historie-Erhalt)
- `concurrency` auf Deploys → nur ein Deploy pro Environment zur Zeit

## GitHub Secrets

### Demo (pflicht für Deploy)
- `DEMO_SSH_KEY` — privater ed25519 Key (Format mit `-----BEGIN/END OPENSSH PRIVATE KEY-----`)
- `DEMO_HOST` — `46.224.7.60`
- `DEMO_USER` — `root`

### Prod (erst wenn VM existiert)
- `PROD_SSH_KEY`, `PROD_HOST`, `PROD_USER`
- **Repository Variable** `PROD_ENABLED` = `true` schaltet den Prod-Deploy scharf

## Server-Layout (demo)

```
/opt/app/                 ← git clone origin, branch demo
  ├── .env                ← LIEGT NUR AUF DEM SERVER (Secrets, DOMAIN_NAME, VITE_APP_TITLE="Demo Aktenanalyse")
  ├── docker-compose.yml  ← wird vom Repo gepflegt
  └── …
/var/lib/docker/volumes/app_db-data  ← SQLite (Bestandsdaten, nicht in git)
```

**Deploy-Schritt (vom GH-Action-Runner ausgeführt):**
```bash
ssh root@46.224.7.60
cd /opt/app
git fetch --prune origin
git reset --hard origin/demo
docker compose up -d --build
```

`.env` bleibt auf dem Server und wird nicht überschrieben (steht im `.gitignore`).

## Title / Branding

Page-Title wird per `VITE_APP_TITLE` Build-Arg gesteuert.
- Default (prod): `Aktenanalyse`
- Demo: `Demo Aktenanalyse` (gesetzt in `/opt/app/.env` auf dem demo-Server)

Dev-Container (`docker-compose.dev.yml`) default `Aktenanalyse (dev)`.
