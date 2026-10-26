# Railway: the API and the Celery worker in ONE service. Railway volumes cannot be shared between
# services, and both read and write uploaded PDFs, so they run side by side on one volume
# (mounted at /data/storage). Build context: the repo root (the seed data is copied in too).
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    STORAGE_DIR=/data/storage PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libgl1 libglib2.0-0 libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ /app/
COPY seed/ /seed/
COPY deploy/railway/backend-start.sh /start.sh
RUN chmod +x /start.sh && mkdir -p /data/storage
# Runs as root: Railway mounts volumes owned by root.
CMD ["/start.sh"]
