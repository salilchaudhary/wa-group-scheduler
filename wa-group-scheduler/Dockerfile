FROM node:22-bookworm-slim

# Chromium for WhatsApp Web + fonts so emoji/Indic text render properly
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji fonts-noto-core ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    DATA_DIR=/app/data

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

EXPOSE 3000
CMD ["node", "src/server.js"]
