#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Hetzner Server Setup for TBS Aktenanalyse
# Run as root on a fresh Ubuntu 22.04/24.04 Hetzner VPS
#
# Usage: ssh root@YOUR_IP 'bash -s' < scripts/setup-hetzner.sh
# ============================================================

echo "=== TBS Aktenanalyse — Hetzner Setup ==="

# 1. System updates
echo "[1/6] System-Updates..."
apt-get update -qq && apt-get upgrade -y -qq

# 2. Install Docker (official method)
echo "[2/6] Docker installieren..."
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable docker
  echo "  Docker installiert: $(docker --version)"
else
  echo "  Docker bereits vorhanden: $(docker --version)"
fi

# 3. Firewall
echo "[3/6] Firewall konfigurieren..."
apt-get install -y -qq ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
echo "  UFW aktiv: SSH + HTTP + HTTPS"

# 4. Create app directory
echo "[4/6] App-Verzeichnis erstellen..."
APP_DIR=/opt/tbs-aktenanalyse
mkdir -p "$APP_DIR"

# 5. Clone or prepare for git pull
echo "[5/6] Git einrichten..."
apt-get install -y -qq git
if [ ! -d "$APP_DIR/.git" ]; then
  echo "  Repo wird beim ersten Deploy geklont."
  echo "  Bitte ausführen:"
  echo "    cd $APP_DIR"
  echo "    git clone <REPO_URL> ."
else
  echo "  Git-Repo existiert bereits."
fi

# 6. Create .env template
echo "[6/6] .env-Vorlage erstellen..."
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# TBS Aktenanalyse — Produktions-Umgebungsvariablen
# WICHTIG: Alle Werte ausfüllen!

ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=HIER_MINDESTENS_32_ZEICHEN_ZUFALLSSTRING
DB_ENCRYPTION_KEY=HIER_MINDESTENS_32_ZEICHEN_HEX
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=SICHERES_PASSWORT_HIER

# Optional
EXTRACTION_MODEL=claude-sonnet-4-6
UTILITY_MODEL=claude-haiku-4-5-20251001
UPLOAD_MAX_SIZE_MB=50
RATE_LIMIT_EXTRACTIONS_PER_HOUR=10
LOG_LEVEL=info
DATA_RETENTION_HOURS=72

# Für Traefik/TLS (später):
# DOMAIN_NAME=aktenanalyse.example.de
# ACME_EMAIL=admin@example.de
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "  .env erstellt unter $ENV_FILE — bitte ausfüllen!"
else
  echo "  .env existiert bereits."
fi

echo ""
echo "=== Setup abgeschlossen ==="
echo ""
echo "Nächste Schritte:"
echo "  1. cd $APP_DIR"
echo "  2. git clone <REPO_URL> .    (oder Dateien kopieren)"
echo "  3. nano .env                  (Werte ausfüllen)"
echo "  4. docker compose -f docker-compose.prod-ip.yml up --build -d"
echo "  5. Öffne http://$(curl -s ifconfig.me) im Browser"
echo ""
