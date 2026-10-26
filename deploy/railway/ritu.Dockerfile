# Railway: the Ritu voice server. Build context: the repo root.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY ritu-voice/package.json ritu-voice/package-lock.json ./
RUN npm ci --omit=dev
COPY ritu-voice/ ./
CMD ["sh", "-c", "node db/migrate.js && node index.js"]
