#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Deploy/Update TBS Aktenanalyse
# Run on the Hetzner server from the project directory
#
# Usage: ./scripts/deploy.sh
# ============================================================

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "=== TBS Aktenanalyse — Deploy ==="

# Check .env exists
if [ ! -f .env ]; then
  echo "FEHLER: .env nicht gefunden. Bitte zuerst einrichten."
  exit 1
fi

# Pull latest code
echo "[1/3] Git pull..."
git pull --ff-only

# Build and restart
echo "[2/3] Docker build + restart..."
COMPOSE_FILE="docker-compose.prod-ip.yml"
# Use Traefik version if DOMAIN_NAME is set in .env
if grep -q '^DOMAIN_NAME=' .env 2>/dev/null; then
  DOMAIN=$(grep '^DOMAIN_NAME=' .env | cut -d= -f2)
  if [ -n "$DOMAIN" ]; then
    COMPOSE_FILE="docker-compose.yml"
    echo "  Domain erkannt: $DOMAIN — verwende Traefik-Konfiguration"
  fi
fi

docker compose -f "$COMPOSE_FILE" up --build -d

# Health check
echo "[3/3] Health-Check..."
sleep 5
if docker compose -f "$COMPOSE_FILE" ps | grep -q "running"; then
  echo ""
  echo "=== Deploy erfolgreich ==="
  docker compose -f "$COMPOSE_FILE" ps
else
  echo ""
  echo "WARNUNG: Container nicht healthy. Logs prüfen:"
  echo "  docker compose -f $COMPOSE_FILE logs --tail=50"
fi
