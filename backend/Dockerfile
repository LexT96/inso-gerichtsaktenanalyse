FROM node:20-alpine AS builder

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install

COPY backend/tsconfig.json ./
COPY backend/src ./src

RUN npx tsc

FROM node:20-alpine

WORKDIR /app

# Python + pymupdf for GPT-5.4 PDF-to-image conversion
RUN apk add --no-cache tini python3 py3-pip && \
    pip3 install --break-system-packages pymupdf

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY backend/src/db/migrations ./dist/db/migrations
COPY standardschreiben ./standardschreiben
COPY gutachtenvorlagen ./gutachtenvorlagen

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
