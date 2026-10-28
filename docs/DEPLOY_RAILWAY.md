# Deploying on Railway

Railway does not run `docker-compose.yml`, so each part is its own Railway service. All services
build from this one repo. Leave **Root Directory** empty (the repo root) and choose each Dockerfile
with the variable `RAILWAY_DOCKERFILE_PATH`.

| Service | How to add | Dockerfile |
|---|---|---|
| `Postgres` | Add → Database → PostgreSQL | |
| `Redis` | Add → Database → Redis | |
| `backend` | Add → GitHub repo → ritu-oncoready | `deploy/railway/backend.Dockerfile` |
| `frontend` | Add → GitHub repo → ritu-oncoready | `deploy/railway/frontend.Dockerfile` |
| `ritu` (voice, optional) | Add → GitHub repo → ritu-oncoready | `deploy/railway/ritu.Dockerfile` |
| `Postgres-Ritu` (voice, optional) | Add → Database → PostgreSQL | |

Name the services exactly as above (Settings → Service name): the variables below refer to them by
name. `${{...}}` are Railway reference variables; paste them as written.

## 1. backend (API + worker + demo data)

The API and the background worker (OCR, extraction) run in this one service, because both use the
uploaded files and Railway cannot share a volume between services.

1. **Volume:** right-click the service → Attach volume → mount path `/data/storage`.
2. **Networking:** Generate Domain.
3. **Variables** (Raw Editor):
   ```
   RAILWAY_DOCKERFILE_PATH=deploy/railway/backend.Dockerfile
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   JWT_SECRET=<a long random string, 32+ characters>
   GEMINI_API_KEY=<your key>
   CORS_ORIGINS=https://${{frontend.RAILWAY_PUBLIC_DOMAIN}}
   OCR_ENGINES=tesseract
   SEED_DEMO=0
   BOOTSTRAP_CLINIC_NAME=City Cancer Centre
   BOOTSTRAP_CLINIC_CODE=CCC
   BOOTSTRAP_DOCTOR_EMAIL=you@example.com
   BOOTSTRAP_DOCTOR_NAME=Dr. Your Name
   BOOTSTRAP_DOCTOR_PASSWORD=<at least 10 characters>
   ```
   - `BOOTSTRAP_*`: creates your clinic and its first doctor on start (safe to repeat). Patients
     sign up at `https://<frontend domain>/join/CCC`; the doctor signs in at `/login` with
     organization `ccc` (the code in lower case), the email and the password.
   - SMS: add `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` to send real one-time codes. Without them the
     code is shown on screen (demo), which is fine for test accounts only.
   - `OCR_ENGINES=tesseract`: PaddleOCR needs a lot of memory. Add it back later (`paddleocr,tesseract`)
     on a larger plan.
   - `SEED_DEMO=1` instead loads the synthetic demo org (code `DEMO`), cases, Maria and John.

## 2. frontend

1. **Networking:** Generate Domain.
2. **Variables:**
   ```
   RAILWAY_DOCKERFILE_PATH=deploy/railway/frontend.Dockerfile
   NEXT_PUBLIC_API_URL=https://${{backend.RAILWAY_PUBLIC_DOMAIN}}
   ```
   The API address is built into the site, so redeploy the frontend if the backend's domain changes.

Open the frontend's domain and sign in: org `demo`, `doctor@demo.example.com` /
`synthetic-demo-pass` (patients: `maria@…`, `john@…`).

## 3. Voice: ritu (optional)

Without it, "Talk to Ritu" is a typed simulator, and the records assistant reads answers aloud in the
browser's own voice.

1. **Networking:** Generate Domain (browsers stream audio to it over a websocket).
2. **Variables:** paste the contents of your local `ritu-voice/.env` into the Raw Editor (Sarvam key,
   Exotel values, clinic name). Then set or replace these:
   ```
   RAILWAY_DOCKERFILE_PATH=deploy/railway/ritu.Dockerfile
   PORT=8090
   DATABASE_URL=${{Postgres-Ritu.DATABASE_URL}}
   GEMINI_API_KEY=${{backend.GEMINI_API_KEY}}
   ONCOREADY_SHARED_SECRET=<a long random string>
   ONCOREADY_PUBLIC_WS_BASE=wss://${{RAILWAY_PUBLIC_DOMAIN}}
   ```
3. **Add to backend's variables:**
   ```
   RITU_BASE_URL=http://${{ritu.RAILWAY_PRIVATE_DOMAIN}}:8090
   RITU_SHARED_SECRET=${{ritu.ONCOREADY_SHARED_SECRET}}
   PUBLIC_API_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   ```
   OncoReady calls Ritu over Railway's private network. Ritu sends finished conversations back to the
   backend's public address, signed with the shared secret.

## Notes

- **Synthetic data only.** A public URL lets anyone sign up and upload. Use the demo personas, and do
  not let real patient records go in (CLAUDE.md rule 2).
- **Recording upload and audio** work the same as locally. Browsers allow the microphone only on
  https, which Railway domains are.
- **Logs:** each service's Deployments → View logs. The backend log shows migrations, the worker
  starting, and the demo seed.
