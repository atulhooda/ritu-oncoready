# OncoReady in ONE container: the website (Next.js), the API (FastAPI) and the background worker
# (Celery: OCR + extraction), behind Caddy on Railway's $PORT:
#     /api/*  -> the API (the /api prefix is removed)        everything else -> the website
# One address, so no API URL to configure and no CORS. Postgres and Redis are separate services.
# Railway builds this file automatically (it is at the repo root). Local development still uses
# docker-compose.yml, with the frontend and backend as separate dev servers.

# ─── website build ───────────────────────────────────────────────────────────────
FROM node:22-slim AS web
WORKDIR /web
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_URL=/api
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx next build

# ─── runtime ─────────────────────────────────────────────────────────────────────
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NEXT_TELEMETRY_DISABLED=1 \
    STORAGE_DIR=/data/storage PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
# tesseract: OCR; libgl/glib/gomp: PaddleOCR / OpenCV runtime libs; ffmpeg: recording remux
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libgl1 libglib2.0-0 libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=caddy:2.8.4 /usr/bin/caddy /usr/bin/caddy

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY seed/ /seed/
COPY --from=web /web/.next/standalone /app/frontend/
COPY --from=web /web/.next/static /app/frontend/.next/static
COPY --from=web /web/public /app/frontend/public
COPY deploy/Caddyfile deploy/start.sh /app/deploy/
RUN chmod +x /app/deploy/start.sh && mkdir -p /data/storage

CMD ["/app/deploy/start.sh"]
