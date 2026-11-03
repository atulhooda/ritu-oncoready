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

Open the address. Patients sign up there; doctors tap "Doctor or hospital? Log in here" and enter
the clinic code, email and password. The API's own pages are at `/api/docs`.

- `BOOTSTRAP_*` creates your clinic and its first doctor on start (safe to repeat). The doctor
  password needs at least 10 characters. Changing it later does not change an existing doctor.
- With more than one clinic, set `DEFAULT_CLINIC_CODE` for the main page; other clinics use
  `https://<your domain>/join/<CODE>`.
- `OCR_ENGINES=tesseract`: PaddleOCR needs a lot of memory; add it back (`paddleocr,tesseract`) on a
  larger plan.
- SMS: `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` send real one-time codes. Without them, or WhatsApp
  (below), the code is shown on screen (demo), which is fine for test accounts only.
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

## WhatsApp verification (free)

Patients prove their number by sending `JOIN <clinic code> <code>` from their own WhatsApp. Messages
a customer sends you, and your replies within 24 hours, are free on the WhatsApp Cloud API.

1. **backend variables:**
   ```
   WHATSAPP_NUMBER=+91XXXXXXXXXX          # the business number patients message
   WHATSAPP_APP_SECRET=<Meta app secret>  # Meta App Dashboard → App settings → Basic
   WHATSAPP_VERIFY_TOKEN=<any string you choose>
   # optional, for a free "verified" reply:
   WHATSAPP_ACCESS_TOKEN=<permanent system-user token>
   WHATSAPP_PHONE_NUMBER_ID=<from WhatsApp → API Setup>
   ```
2. **Webhook.** In the Meta app: WhatsApp → Configuration → Webhook. Callback URL
   `https://<your domain>/api/integrations/whatsapp/webhook`, verify token as above; subscribe to
   `messages`.
3. **If that number's webhook already points at another site** (a Meta app has one webhook URL),
   either use a separate app/number for OncoReady, or have the other site forward each webhook
   POST to the URL above **unchanged**: the same raw body and the `X-Hub-Signature-256` header.
   OncoReady ignores messages that are not `JOIN ...`, so forwarding everything is fine.

## Notes

- **Synthetic data only.** A public URL lets anyone sign up and upload. Use test accounts, and do
  not let real patient records go in (CLAUDE.md rule 2).
- **Logs:** the service's Deployments → View logs. On start you see the migrations, the clinic
  set-up ("clinic created", "doctor created"), the worker ("celery … ready") and the website
  ("Ready in …").
