#!/bin/bash
set -euo pipefail

GIT_REPO_URL="$1"
GIT_BRANCH="$2"

echo "=== Installing Docker ==="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "=== Cloning repository ==="
git clone --branch "$GIT_BRANCH" --depth 1 "$GIT_REPO_URL" /opt/app/repo

echo "=== Copying .env into repo ==="
cp /opt/app/.env /opt/app/repo/.env

echo "=== Building and starting with Docker Compose ==="
cd /opt/app/repo

# Use IP-only compose (no TLS) when no domain is configured
DOMAIN_NAME=$(grep '^DOMAIN_NAME=' .env | cut -d= -f2)
if [ -z "$DOMAIN_NAME" ]; then
  echo "No domain configured — starting in IP-only mode (HTTP on port 80)"
  docker compose -f docker-compose.prod-ip.yml up --build -d
else
  echo "Domain configured: $DOMAIN_NAME — starting with Caddy TLS"
  docker compose up --build -d
fi

echo "=== Enabling automatic security updates ==="
systemctl enable unattended-upgrades
systemctl start unattended-upgrades

echo "=== Setup complete ==="
