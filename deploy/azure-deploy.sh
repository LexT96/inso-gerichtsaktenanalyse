#!/usr/bin/env bash
set -euo pipefail

# ─── Azure Deployment for InsolvenzAkte Extraktor ───
#
# Prerequisites:
#   1. Azure CLI installed: https://learn.microsoft.com/cli/azure/install-azure-cli
#   2. Logged in: az login
#   3. Docker installed (for building images)
#
# Usage:
#   ./deploy/azure-deploy.sh
#
# What this creates:
#   - Resource Group in germanywestcentral
#   - Azure Container Registry (ACR)
#   - Azure Container App Environment
#   - Two Container Apps (backend + frontend)
#   - Azure File Share for SQLite persistence
#
# Estimated cost: ~€30-50/month (Container Apps consumption plan)

# ─── Configuration ───
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-insolvenz-extraktor-rg}"
LOCATION="${AZURE_LOCATION:-germanywestcentral}"
ACR_NAME="${AZURE_ACR_NAME:-insolvenzextraktorcr}"
ENVIRONMENT_NAME="insolvenz-env"
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-insolvenzdata}"
SHARE_NAME="dbdata"

echo "╔══════════════════════════════════════════════════╗"
echo "║  InsolvenzAkte Extraktor — Azure Deployment      ║"
echo "║  Region: ${LOCATION}                             ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ─── Check prerequisites ───
command -v az >/dev/null 2>&1 || { echo "ERROR: Azure CLI nicht installiert. https://learn.microsoft.com/cli/azure/install-azure-cli"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker nicht installiert."; exit 1; }

az account show >/dev/null 2>&1 || { echo "ERROR: Nicht angemeldet. Bitte 'az login' ausführen."; exit 1; }

SUBSCRIPTION=$(az account show --query name -o tsv)
echo "Azure-Abonnement: ${SUBSCRIPTION}"
echo "Resource Group:    ${RESOURCE_GROUP}"
echo "Region:            ${LOCATION}"
echo ""
read -p "Fortfahren? (j/n) " -n 1 -r
echo ""
[[ $REPLY =~ ^[Jj]$ ]] || exit 0

# ─── Load secrets from .env ───
if [ -f .env ]; then
  echo "→ Lade Konfiguration aus .env..."
  set -a
  source .env
  set +a
else
  echo "ERROR: .env Datei nicht gefunden. Bitte erstellen (siehe .env.example)."
  exit 1
fi

# Validate required vars
for var in ANTHROPIC_API_KEY JWT_SECRET DEFAULT_ADMIN_PASSWORD DB_ENCRYPTION_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: ${var} ist nicht in .env gesetzt."
    exit 1
  fi
done

# ─── Step 1: Resource Group ───
echo ""
echo "═══ 1/7: Resource Group ═══"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o none
echo "✓ Resource Group erstellt: ${RESOURCE_GROUP}"

# ─── Step 2: Container Registry ───
echo ""
echo "═══ 2/7: Container Registry ═══"
az acr create --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --sku Basic --admin-enabled true -o none
echo "✓ Container Registry erstellt: ${ACR_NAME}.azurecr.io"

ACR_SERVER="${ACR_NAME}.azurecr.io"
ACR_PASSWORD=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)

# ─── Step 3: Build & Push Images ───
echo ""
echo "═══ 3/7: Docker Images bauen und pushen ═══"

az acr login --name "$ACR_NAME"

echo "→ Backend-Image bauen..."
docker build -t "${ACR_SERVER}/backend:latest" -f backend/Dockerfile .
docker push "${ACR_SERVER}/backend:latest"
echo "✓ Backend-Image gepusht"

echo "→ Frontend-Image bauen..."
docker build -t "${ACR_SERVER}/frontend:latest" -f frontend/Dockerfile .
docker push "${ACR_SERVER}/frontend:latest"
echo "✓ Frontend-Image gepusht"

# ─── Step 4: Storage for SQLite ───
echo ""
echo "═══ 4/7: Persistenter Speicher ═══"
az storage account create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$STORAGE_ACCOUNT" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --min-tls-version TLS1_2 \
  -o none

STORAGE_KEY=$(az storage account keys list --resource-group "$RESOURCE_GROUP" --account-name "$STORAGE_ACCOUNT" --query "[0].value" -o tsv)

az storage share create --account-name "$STORAGE_ACCOUNT" --account-key "$STORAGE_KEY" --name "$SHARE_NAME" -o none
echo "✓ Azure File Share erstellt: ${SHARE_NAME}"

# ─── Step 5: Container App Environment ───
echo ""
echo "═══ 5/7: Container App Environment ═══"
az containerapp env create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ENVIRONMENT_NAME" \
  --location "$LOCATION" \
  -o none

az containerapp env storage set \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ENVIRONMENT_NAME" \
  --storage-name dbstorage \
  --azure-file-account-name "$STORAGE_ACCOUNT" \
  --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name "$SHARE_NAME" \
  --access-mode ReadWrite \
  -o none
echo "✓ Environment erstellt mit persistentem Speicher"

# ─── Step 6: Backend Container App ───
echo ""
echo "═══ 6/7: Backend Container App ═══"

DOMAIN_NAME="${DOMAIN_NAME:-}"

az containerapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "backend" \
  --environment "$ENVIRONMENT_NAME" \
  --image "${ACR_SERVER}/backend:latest" \
  --registry-server "$ACR_SERVER" \
  --registry-username "$ACR_NAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 3004 \
  --ingress internal \
  --min-replicas 1 \
  --max-replicas 1 \
  --cpu 1.0 \
  --memory 2.0Gi \
  --secrets \
    "anthropic-key=${ANTHROPIC_API_KEY}" \
    "jwt-secret=${JWT_SECRET}" \
    "admin-password=${DEFAULT_ADMIN_PASSWORD}" \
    "db-encryption-key=${DB_ENCRYPTION_KEY}" \
  --env-vars \
    "NODE_ENV=production" \
    "ANTHROPIC_API_KEY=secretref:anthropic-key" \
    "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}" \
    "EXTRACTION_MODEL=${EXTRACTION_MODEL:-claude-sonnet-4-6}" \
    "UTILITY_MODEL=${UTILITY_MODEL:-claude-haiku-4-5-20251001}" \
    "JWT_SECRET=secretref:jwt-secret" \
    "JWT_ACCESS_EXPIRY=${JWT_ACCESS_EXPIRY:-15m}" \
    "JWT_REFRESH_EXPIRY=${JWT_REFRESH_EXPIRY:-7d}" \
    "DATABASE_PATH=/data/insolvenz.db" \
    "UPLOAD_MAX_SIZE_MB=${UPLOAD_MAX_SIZE_MB:-50}" \
    "RATE_LIMIT_EXTRACTIONS_PER_HOUR=${RATE_LIMIT_EXTRACTIONS_PER_HOUR:-10}" \
    "DEFAULT_ADMIN_USERNAME=${DEFAULT_ADMIN_USERNAME:-admin}" \
    "DEFAULT_ADMIN_PASSWORD=secretref:admin-password" \
    "CORS_ORIGIN=https://${DOMAIN_NAME:-insolvenz.example.com}" \
    "PORT=3004" \
    "LOG_LEVEL=${LOG_LEVEL:-info}" \
    "DATA_RETENTION_HOURS=${DATA_RETENTION_HOURS:-72}" \
    "DB_ENCRYPTION_KEY=secretref:db-encryption-key" \
  -o none

BACKEND_FQDN=$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "backend" --query "properties.configuration.ingress.fqdn" -o tsv)
echo "✓ Backend deployed (internal): https://${BACKEND_FQDN}"

# ─── Step 7: Frontend Container App ───
echo ""
echo "═══ 7/7: Frontend Container App ═══"

az containerapp create \
  --resource-group "$RESOURCE_GROUP" \
  --name "frontend" \
  --environment "$ENVIRONMENT_NAME" \
  --image "${ACR_SERVER}/frontend:latest" \
  --registry-server "$ACR_SERVER" \
  --registry-username "$ACR_NAME" \
  --registry-password "$ACR_PASSWORD" \
  --target-port 80 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.5 \
  --memory 1.0Gi \
  -o none

FRONTEND_FQDN=$(az containerapp show --resource-group "$RESOURCE_GROUP" --name "frontend" --query "properties.configuration.ingress.fqdn" -o tsv)

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Deployment abgeschlossen!                       ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║                                                  ║"
echo "  App URL:  https://${FRONTEND_FQDN}"
echo "║                                                  ║"
echo "║  Nächste Schritte:                               ║"
echo "║  1. Custom Domain + TLS konfigurieren            ║"
echo "║  2. CORS_ORIGIN im Backend aktualisieren         ║"
echo "║  3. Volume Mount für /data hinzufügen (YAML)     ║"
echo "║                                                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Hinweis: Für Volume Mounts (SQLite-Persistenz) muss"
echo "das Backend per YAML-Template aktualisiert werden:"
echo ""
echo "  az containerapp show -n backend -g ${RESOURCE_GROUP} -o yaml > backend-app.yaml"
echo "  # volumeMounts und volumes Abschnitte hinzufügen"
echo "  az containerapp update -n backend -g ${RESOURCE_GROUP} --yaml backend-app.yaml"
echo ""
echo "Für Langdock/Azure AI: ANTHROPIC_BASE_URL in .env setzen."
