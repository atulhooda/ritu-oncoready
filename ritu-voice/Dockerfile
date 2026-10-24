# Local/docker runs (production deploys on Railway). Used by OncoReady's
# docker-compose "voice" profile; works standalone too.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN useradd --create-home ritu && chown -R ritu:ritu /app
USER ritu
EXPOSE 3000
CMD ["sh", "-c", "node db/migrate.js && node index.js"]
