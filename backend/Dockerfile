FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    STORAGE_DIR=/data/storage PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
# tesseract: OCR fallback; libgl/glib/gomp: runtime libs for PaddleOCR / OpenCV; ffmpeg: recording remux
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libgl1 libglib2.0-0 libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home app \
    && mkdir -p /data/storage /home/app/.paddlex \
    && chown -R app:app /data /home/app/.paddlex
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
