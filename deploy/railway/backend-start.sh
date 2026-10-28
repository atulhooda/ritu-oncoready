#!/bin/sh
# Railway backend: migrate, start the worker, optionally load the synthetic demo, serve the API.
set -e
alembic upgrade head

if [ "${RUN_WORKER:-1}" = "1" ]; then
  celery -A app.worker.celery_app worker --loglevel=info --concurrency="${WORKER_CONCURRENCY:-1}" &
fi

# Your clinic and its first doctor, from BOOTSTRAP_CLINIC_* / BOOTSTRAP_DOCTOR_* (safe to repeat).
python -m app.cli bootstrap || echo "clinic bootstrap failed (the API still starts)"

# Synthetic demo org, cases and personas. Safe to repeat: anything already loaded is skipped.
if [ "${SEED_DEMO:-0}" = "1" ]; then
  (python /seed/seed.py && python /seed/seed.py --intake) || echo "demo seed failed (the API still starts)"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips="*"
