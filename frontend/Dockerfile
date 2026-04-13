FROM node:20-alpine AS builder

# Replicate local directory structure so ../shared works from frontend/
WORKDIR /workspace/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/index.html ./
COPY frontend/tsconfig.json ./
COPY frontend/vite.config.ts ./
COPY frontend/tailwind.config.js ./
COPY frontend/postcss.config.js ./
COPY frontend/public ./public
# Fallback: Demo-PDF aus testdokumente, falls public/demo/test-pdf.pdf fehlt
COPY testdokumente/ ./testdokumente/
RUN mkdir -p public/demo && \
  if [ ! -f public/demo/test-pdf.pdf ]; then \
    cp "testdokumente/Gerichtsakte Demo - synthetisch.pdf" public/demo/test-pdf.pdf 2>/dev/null || true; \
  fi
COPY frontend/src ./src
# Fallback: Demo-PDF für Vite-Asset-Import (src/assets/demo/)
RUN mkdir -p src/assets/demo && \
  if [ ! -f src/assets/demo/test-pdf.pdf ]; then \
    cp "testdokumente/Gerichtsakte Demo - synthetisch.pdf" src/assets/demo/test-pdf.pdf 2>/dev/null || true; \
  fi
COPY shared /workspace/shared

ARG VITE_AZURE_TENANT_ID
ARG VITE_AZURE_CLIENT_ID
ARG VITE_ENABLE_DEMO_FLOW
ENV VITE_AZURE_TENANT_ID=$VITE_AZURE_TENANT_ID
ENV VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID
ENV VITE_ENABLE_DEMO_FLOW=$VITE_ENABLE_DEMO_FLOW

RUN npm run build

FROM nginx:alpine

COPY --from=builder /workspace/frontend/dist /usr/share/nginx/html
RUN chmod -R 755 /usr/share/nginx/html

# Nginx config — envsubst replaces $BACKEND_URL at container start
RUN mkdir -p /etc/nginx/templates && \
    cat > /etc/nginx/templates/default.conf.template <<'NGINX'
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location /api {
        proxy_pass ${BACKEND_URL};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;
        client_max_body_size 55m;
    }
    location /demo/ {
        alias /usr/share/nginx/html/demo/;
        add_header Cache-Control "no-cache";
    }
    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

ENV BACKEND_URL=http://backend:3004

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
