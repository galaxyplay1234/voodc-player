FROM node:20-slim

# Dependências mínimas para o Chromium do Puppeteer
RUN apt-get update && apt-get install -y \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcap2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxshmfence1 \
    wget xdg-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

# (Opcional) Baixar Chromium no build para cold-start mais rápido
# Se der erro de build, remova esta etapa que o Puppeteer baixa em runtime.
RUN node -e "require('puppeteer').createBrowserFetcher().download('133.0.6943.53').then(()=>console.log('Chromium ok')).catch(()=>process.exit(0))"

COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]