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
    cp "testdokumente/Gerichtsakte (gutes Beispiel).pdf" public/demo/test-pdf.pdf 2>/dev/null || true; \
  fi
COPY frontend/src ./src
# Fallback: Demo-PDF für Vite-Asset-Import (src/assets/demo/)
RUN mkdir -p src/assets/demo && \
  if [ ! -f src/assets/demo/test-pdf.pdf ]; then \
    cp "testdokumente/Gerichtsakte (gutes Beispiel).pdf" src/assets/demo/test-pdf.pdf 2>/dev/null || true; \
  fi
COPY shared /workspace/shared

RUN npm run build

FROM nginx:alpine

COPY --from=builder /workspace/frontend/dist /usr/share/nginx/html
RUN chmod -R 755 /usr/share/nginx/html

RUN printf 'server {\n\
    listen 80;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location /api {\n\
        proxy_pass http://backend:3001;\n\
        proxy_http_version 1.1;\n\
        proxy_set_header Host $host;\n\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n\
        proxy_read_timeout 600s;\n\
        client_max_body_size 55m;\n\
    }\n\
    location /demo/ {\n\
        alias /usr/share/nginx/html/demo/;\n\
        add_header Cache-Control "no-cache";\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
