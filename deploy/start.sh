#!/bin/bash
# Starts the whole app in one container: migrate, set up the clinic, then the worker, the API, the
# website and the router. If any of them stops, the container exits and Railway restarts it.
set -e
cd /app/backend
alembic upgrade head

# Your clinic and its first doctor, from BOOTSTRAP_CLINIC_* / BOOTSTRAP_DOCTOR_* (safe to repeat).
python -m app.cli bootstrap || echo "clinic bootstrap: see the message above (the app still starts)"

celery -A app.worker.celery_app worker --loglevel=info --concurrency="${WORKER_CONCURRENCY:-1}" &

# Synthetic demo org, cases and personas. Safe to repeat: anything already loaded is skipped.
if [ "${SEED_DEMO:-0}" = "1" ]; then
  (python /seed/seed.py && python /seed/seed.py --intake) || echo "demo seed failed (the app still starts)"
fi

uvicorn app.main:app --host 127.0.0.1 --port 8000 --root-path /api --proxy-headers --forwarded-allow-ips="*" &
(cd /app/frontend && HOSTNAME=127.0.0.1 PORT=3000 node server.js) &
caddy run --config /app/deploy/Caddyfile --adapter caddyfile &

wait -n
echo "a process stopped; exiting so the platform restarts the app"
exit 1
