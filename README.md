# Ritu OncoReady

Synthetic oncology case-readiness training. See [CLAUDE.md](CLAUDE.md) for the rules every change must follow.

```bash
cp .env.example .env   # set GEMINI_API_KEY and/or GROQ_API_KEY for extraction
docker compose up --build
# backend  http://localhost:8000/docs
# frontend http://localhost:3000
docker compose exec backend python /seed/seed.py   # synthetic demo org + cases, runs pipeline
docker compose exec backend python /seed/recall.py # extraction recall vs answer keys
```

Backend tests need a Postgres database:

```bash
cd backend
uv venv --python 3.12 && uv pip install -r requirements-dev.txt
TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/oncoready_test .venv/bin/pytest
```
