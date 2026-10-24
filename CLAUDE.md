# Ritu OncoReady

Training tool: residents read a **synthetic** oncology case, write a readiness brief, and get a
deterministic score against a faculty answer key.

## Layout

- `backend/` — FastAPI, Python 3.12, SQLAlchemy 2 (sync, psycopg 3), Alembic, Pydantic v2, Celery
- `frontend/` — Next.js (App Router), TypeScript, Tailwind
- `seed/` — synthetic cases only
- `ritu-voice/` — the Ritu voice server (Node; Sarvam speech); see `ritu-voice/ARCHITECTURE.md`
- `docker-compose.yml` — postgres, redis, backend, worker, frontend

## Commands

```bash
docker compose up --build                       # full stack
cd backend && .venv/bin/alembic upgrade head    # migrate (DATABASE_URL env)
cd backend && .venv/bin/pytest                  # tests (TEST_DATABASE_URL env, Postgres required)
cd backend && .venv/bin/alembic check           # models and migrations must agree
backend/.venv/bin/python seed/render.py         # re-render seed PDFs + REVIEW_FOR_DOCTOR.md
docker compose exec backend python /seed/seed.py [--reprocess]   # load cases, enqueue pipeline
docker compose exec backend python /seed/recall.py               # extraction recall vs answer keys
docker compose exec backend python /seed/seed.py --demo-briefs   # submit + score demo resident briefs
docker compose exec backend python /seed/seed.py --intake        # doctor + patient personas
```

## Document pipeline (`app/pipeline/`, Celery)

`ocr_document -> extract_document -> derive_case`, all org-scoped via repositories.
- OCR: PaddleOCR, Tesseract fallback; per-page text + confidence + engine. `paddlepaddle==3.0.0`
  is pinned (3.2+ segfaults on linux/aarch64).
- Extraction: LLM returns candidates (page number + span). Spans are aligned to the page OCR text
  with rapidfuzz (>= `span_match_threshold`, 0.85) and the **aligned OCR substring** is stored.
  Anything failing validation goes to `rejected_extractions` with a reason, never the timeline.
- Dates are parsed in `dates.py` (US MM/DD/YYYY). The LLM only copies date text.
- Pending tests, discrepancies, and lab flags (LVEF drop >= 10 points) are code in `derive.py`.
- Invariant fields (histology, primary site, stage, HER2/ER/PR) are compared across documents
  regardless of date in `invariants.py`. A stage change is excused only by a dated
  `response_assessment` event between the two stages; c/p/y stages are compared within their
  own system only.

## Non-negotiable rules

### 1. Multi-tenant
- Every table has `org_id` (`orgs.id` is the tenant itself). No exceptions for new tables.
- Child tables reference parents with **composite FKs** `(org_id, parent_id) -> parent(org_id, id)`,
  so the database rejects cross-org links. Every table therefore has `UNIQUE (org_id, id)`.
- **All** queries go through `app/repositories/`. Repositories are constructed with an `org_id`
  and add `WHERE org_id = :org_id` to every read and set `org_id` on every write.
- Never call `session.execute(select(...))` / `session.get(...)` on tenant data from routes,
  services, or tasks. If a repository method is missing, add one.
- `org_id` comes from the verified JWT (`app/auth/deps.py`), never from the request body or path.
- Cross-org access returns 404, not 403 (don't leak existence).
- `tests/test_tenant_isolation.py` must keep passing; add a case for every new repository.

### 2. No real patient data, no clinical advice
- Only synthetic cases. `patient_cases.is_synthetic` has a `CHECK (is_synthetic)`; do not remove it.
- Do not add features that ingest real PHI (EHR connectors, real uploads in prod, etc.).
- The product never outputs diagnosis or treatment recommendations. It scores a resident's
  brief against a faculty answer key. Copy, prompts, and LLM outputs must not give clinical advice.

### 3. LLM use is extraction only
- One module: `app/llm/client.py`. Gemini primary, Groq fallback. Nothing else imports a provider.
- Every call passes a Pydantic schema; output is validated before it is used. Invalid output
  -> try fallback -> raise. Never store unvalidated LLM output.
- Allowed uses: extracting facts from documents and from intake transcripts (quotes verified
  against the patient's turn), **proposing** brief-to-rubric matches (a match is accepted only
  with a quote verified verbatim in the brief, `app/scoring/matching.py`), and **selecting**
  evidence for the doctor's records assistant (`app/assistant/`): ids + quotes, each verified
  against the offered record text. The assistant's answer text is built in code from verified
  records; the LLM never writes it, and measurement / pending-test questions do not use the LLM.
- LLMs are **not** used for scoring, grading, or generating clinical content.

### 4. Scoring is deterministic
- `app/scoring/engine.py` is a pure function: same rubric + verdicts -> same score and `details`.
- Store `scoring_version` (= `ENGINE_VERSION`) with every score. No LLM, no randomness, no clock.
- Rules live in `BEHAVIOR_SPEC.md` ("Scoring"). Changing them means bumping `ENGINE_VERSION`
  and updating the spec in the same commit.
- Residents cannot read AI-derived case data (timeline, OCR text) until they submit their brief;
  enforce in the API (`ensure_case_unlocked`), never only in the UI.

### 5. Provenance on every extracted fact
- Every extracted fact (`timeline_events`, `pending_tests`) stores `source_page_id` (NOT NULL)
  and `source_text_span` (NOT NULL, non-empty), the **verbatim** text from that page's
  `ocr_text`. Repositories reject spans not found in the page text.
- Derived records (e.g. `discrepancies`) reference the facts they derive from.

### 6. Migrations
- **One Alembic migration per commit.** Don't squash or edit a committed migration; add a new one.
- Migrations are hand-reviewed; `alembic check` must report no drift.
- Enums are stored as `VARCHAR` + `CHECK` (non-native) so up/down migrations stay clean.

### 7. Voice
- Voice is handled by the existing **Ritu voice server** (contract: `docs/VOICE_INTEGRATION.md`).
  Do not build STT/TTS/telephony/voice logic in this repo. `frontend/lib/ritu-voice.ts` is only an
  audio *transport* (mic -> Ritu's `/media-stream`, playback of Ritu's audio).
- All Ritu calls go through `backend/app/voice/client.py`; Ritu's callbacks are HMAC-verified in
  `backend/app/api/integrations.py`.
- The doctor's records assistant reads answers aloud through Ritu (`POST /v1/speech`, Sarvam,
  via `voice/client.synthesize`); its speech *recognition* is the browser's Web Speech API, a
  labelled prototype fallback (`frontend/lib/speech.ts`). No speech logic runs on OncoReady's server.
- Until Ritu ships browser sessions, intake runs in **simulator** mode (typed answers to the same
  script). Keep both paths feeding `intake.service.record_transcript`.

### 8. Roles and who sees what (`app/auth/access.py`)
- `resident`, `faculty`, `admin`: training cases only. `patient`: their own intake case only.
  `doctor`: intake cases the patient has sent (`published_at` set). Everything else is 404.
- Patients are demo personas (rule 2 still applies). Intake facts quote the patient's own
  words from a transcript turn (`intake_facts.source_turn_id` + `source_text_span`).
