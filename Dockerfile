FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]