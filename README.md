# Ritu OncoReady

Synthetic oncology case-readiness training. See [CLAUDE.md](CLAUDE.md) for the rules every change must follow.

```bash
cp .env.example .env
docker compose up --build
# backend  http://localhost:8000/docs
# frontend http://localhost:3000
```

Backend tests need a Postgres database:

```bash
cd backend
uv venv --python 3.12 && uv pip install -r requirements-dev.txt
TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/oncoready_test .venv/bin/pytest
```
