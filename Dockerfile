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

# Se NÃO tiver package-lock.json no repo:
RUN npm install --omit=dev
# (Se você optar por adicionar o package-lock.json, troque por:)
# RUN npm ci --omit=dev

COPY . .

# (Opcional) baixar Chromium no build (com tolerância a falha)
# Se der erro de rede na Koyeb, pode REMOVER estas 2 linhas
RUN node -e "try{require('puppeteer').createBrowserFetcher().download(process.env.PPTR_CHROME_REV||'133.0.6943.53').then(()=>console.log('Chromium ok')).catch(()=>console.log('skip predownload'))}catch(e){console.log('skip predownload')}"
ENV PPTR_EXECUTABLE_PATH=""
# Se você quiser fixar o Chromium do host, pode setar PPTR_EXECUTABLE_PATH, mas não é necessário.

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]