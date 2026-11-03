# Deploying on Railway

OncoReady is **one service** built from this repo, plus Railway's Postgres and Redis databases.
The `Dockerfile` at the repo root builds one image that runs the website, the API (under `/api`)
and the background worker (OCR, extraction) behind one address. Railway finds that Dockerfile on
its own.

| Service | How to add |
|---|---|
| `Postgres` | Add → Database → PostgreSQL |
| `Redis` | Add → Database → Redis |
| `oncoready` | Add → GitHub repo → ritu-oncoready |

**Put all three in the same region** (Settings → Scale → Regions). A database in another region
adds about half a second to every request.

## 1. The app service

1. **Volume:** right-click the service → Attach volume → mount path `/data/storage` (uploaded records).
2. **Networking:** Generate Domain, or add your own (Settings → Networking → Custom Domain).
3. **Variables** (Raw Editor), with your values:
   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   JWT_SECRET=<a long random string: openssl rand -hex 32>
   GEMINI_API_KEY=<your key>
   PUBLIC_API_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}/api
   OCR_ENGINES=tesseract
   SEED_DEMO=0
   BOOTSTRAP_CLINIC_NAME=Your Clinic Name
   BOOTSTRAP_CLINIC_CODE=CLINIC
   BOOTSTRAP_DOCTOR_EMAIL=you@example.com
   BOOTSTRAP_DOCTOR_NAME=Dr. Your Name
   BOOTSTRAP_DOCTOR_PASSWORD=<at least 10 characters>
   ```
   With a custom domain, write it in `PUBLIC_API_URL` instead: `https://your.domain/api`.

Open the address. Patients create an account or log in there; doctors tap "Doctor or hospital? Log in here" and enter
the clinic code, email and password. The API's own pages are at `/api/docs`.

- `BOOTSTRAP_*` creates your clinic and its first doctor on start (safe to repeat). The doctor
  password needs at least 10 characters. Changing it later does not change an existing doctor.
- With more than one clinic, set `DEFAULT_CLINIC_CODE` for the main page; other clinics use
  `https://<your domain>/join/<CODE>`.
- `OCR_ENGINES=tesseract`: PaddleOCR needs a lot of memory; add it back (`paddleocr,tesseract`) on a
  larger plan.
- Phone check: see "WhatsApp phone check" below.
- `SEED_DEMO=1` loads the synthetic demo org (code `DEMO`), cases, Maria and John.

## 2. Voice: your existing Ritu (optional)

Ritu is its own repo and Railway service (engageo-server-v2), used over HTTPS with a shared
secret. Without it, "Talk to Ritu" is a typed simulator, and the records assistant reads answers
aloud in the browser's own voice.

- **Ritu service variables:**
  ```
  ONCOREADY_SHARED_SECRET=<a long random string>
  ONCOREADY_PUBLIC_WS_BASE=wss://<Ritu's public domain>
  ```
- **OncoReady variables:**
  ```
  RITU_BASE_URL=https://<Ritu's public domain>
  RITU_SHARED_SECRET=<the same string>
  ```
  Ritu sends finished conversations to `PUBLIC_API_URL` (signed with the secret).

## WhatsApp phone check

New patients get a 6-digit code on WhatsApp to prove their number. Without this the number is
saved unverified, and sign-up still works.

1. **Template.** In WhatsApp Manager → Message templates → Create template → category
   **Authentication**, with a **Copy code** button. Wait for approval (usually minutes). Note its
   name and language (for example `oncoready_code`, `en`).
2. **Variables** (the same app and number your website uses):
   ```
   WHATSAPP_ACCESS_TOKEN=<permanent system-user token>
   WHATSAPP_PHONE_NUMBER_ID=<WhatsApp Manager → API Setup → Phone number ID>
   WHATSAPP_OTP_TEMPLATE=oncoready_code
   WHATSAPP_OTP_TEMPLATE_LANG=en
   ```
Meta bills authentication messages per message (in India about ₹0.12 each). No webhook is needed.

## Notes

- **Synthetic data only.** A public URL lets anyone sign up and upload. Use test accounts, and do
  not let real patient records go in (CLAUDE.md rule 2).
- **Logs:** the service's Deployments → View logs. On start you see the migrations, the clinic
  set-up ("clinic created", "doctor created"), the worker ("celery … ready") and the website
  ("Ready in …").
