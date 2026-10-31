# Ritu OncoReady

Synthetic oncology case-readiness training. See [CLAUDE.md](CLAUDE.md) for the rules every change must follow.

```bash
cp .env.example .env   # set GEMINI_API_KEY and/or GROQ_API_KEY for extraction
docker compose up --build
# backend  http://localhost:8000/docs
# frontend http://localhost:3000
docker compose exec backend python /seed/seed.py   # synthetic demo org + cases, runs pipeline
docker compose exec backend python /seed/recall.py # extraction recall vs answer keys
docker compose exec backend python /seed/seed.py --demo-briefs  # demo resident briefs, scored
docker compose exec backend python /seed/seed.py --intake       # doctor + patient personas (Maria sent, John fresh)
# sign in at the frontend: org "demo", password synthetic-demo-pass
#   training: resident@ / faculty@demo.example.com
#   intake:   maria@ / john@ (patients), doctor@demo.example.com
```

Real Ritu voice (optional): Ritu is a separate repo. With a Ritu checkout that has the OncoReady
patches (by default `../ritu voice`, or set `RITU_DIR`) and `SARVAM_API_KEY` in its `.env`, run
`docker compose --profile voice up -d --build` (details: `docs/VOICE_INTEGRATION.md` →
"Turning on real voice"). Without it, "Talk to Ritu" runs a typed simulator of the same questions.

Deploying on Railway: see `docs/DEPLOY_RAILWAY.md`.

After changing frontend dependencies, renew the container's `node_modules` volume:
`docker compose up -d --build -V frontend`.

Backend tests need a Postgres database:

```bash
cd backend
uv venv --python 3.12 && uv pip install -r requirements-dev.txt
TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/oncoready_test .venv/bin/pytest
```
