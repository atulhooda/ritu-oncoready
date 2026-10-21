# Onboarding a New Clinic (silo model)

Each clinic is its **own isolated stack**: 1 voice server + 1 dashboard + 1 Postgres,
all from the same GitHub repos. A new clinic = spin up the stack + flip a few env vars.
**~30 minutes, repeatable.** No clinic ever shares data with another.

> Migrations are automatic now: the voice server runs `db/migrate.js` on every deploy
> (`prestart`), so a fresh clinic DB self-builds its schema on first boot. You never run
> migrations by hand again.

---

## Before you start — collect these for the clinic
- Clinic **name**, **address** (Ritu reads it aloud), timezone (usually `Asia/Kolkata`).
- Its **Exotel DID** (the phone number patients call) — under your Exotel account.
- Its **doctor roster**: name, specialty, fee, working days + hours, walk-in or not.
- Optional: its **WhatsApp number** (Meta Phone Number ID) if confirmations are on.

---

## Steps

**1. Create the database**
Railway → New → **Postgres**. Copy its `DATABASE_URL`.

**2. Generate the clinic's ID**
Run `uuidgen` (or any UUID v4 generator). This is the clinic's `CLINIC_ID_UUID` — used
in both services and in the seed. Keep it handy.

**3. Deploy the voice server**
Railway → New → Deploy from GitHub → `engageo-server-v2`. Set env (table below).
On first deploy, `prestart` auto-migrates the empty DB. ✅

**4. Seed the clinic + its doctors**
Copy `db/seed-sai-shradha.js` → `db/seed-<clinic>.js`, change the clinic name + the
`DOCTORS` array to this clinic's roster, and insert the clinic row with the UUID from
step 2. Run it once against the new `DATABASE_URL`:
```
DATABASE_URL=<new-db-url> node db/seed-<clinic>.js
```
*(Ask me and I'll turn this into one parameterized `seed-clinic.js` that takes a config
file — then this step is just editing a JSON.)*

**5. Deploy the dashboard**
Railway → New → Deploy from GitHub → `ritu-desk`. Set its env (table below), pointed at
the **same** `DATABASE_URL` + `CLINIC_ID_UUID`. (The dashboard never migrates.)

**6. Point the phone line at the server**
In Exotel App Bazaar, set the clinic's Voicebot applet WebSocket URL to the new voice
server's `wss://<service-host>/media-stream?sample-rate=8000`. If you use the hard gate,
append `&secret=<MEDIA_STREAM_SECRET>`.

**7. (If WhatsApp on) configure the clinic's Meta number** — set the `META_*` vars.

**8. Test** — call the DID, book a test appointment, confirm it shows in this clinic's
dashboard → **Calls**. Then `npm run demo:clear` (or delete the test rows) before real patients.

---

## Env var reference

**Shared across ALL clinics** (same values everywhere — your accounts):
`SARVAM_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `EXOTEL_SID`, `EXOTEL_API_KEY`,
`EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`, `META_ACCESS_TOKEN`, `META_BUSINESS_ACCOUNT_ID`,
`LLM_PRIMARY_PROVIDER`, `LLM_FALLBACK_PROVIDERS`, `GEMINI_MODEL`, `SPEAKER`, `PACE`,
`ENABLE_*` flags.

`STT_MODE` — saaras:v3 output mode: `transcribe` (default, native script) or `codemix`
(English/Latin words stay in Latin inside Indic text — measured 94% vs 0% survival of
Latin entities like drug names, so `codemix` is the accuracy lever for medicine capture).
Rollout rule: enable on the DEMO deployment first, watch a day of calls, then hospital.

`FORCE_LANG` — pin EVERY call to one language end-to-end (demo / single-language
clinic). Example, a Kannada client demo: `FORCE_LANG=kn-IN` gives a Kannada greeting
(pre-cached at boot, correct voice), STT opens already pinned to Kannada (no
auto-detect), the voice is locked for the whole call (no mid-call speaker changes),
and Ritu replies in Kannada. Unset → normal auto-detect behavior. Pair with:
- `CLINIC_GREETING_NAME` in the same script as the language (e.g. Kannada script)
  so the greeting doesn't mix scripts.
- `SPEAKER_BY_LANG='kn-IN:<voice>'` to override the voice (kn default = suhani —
  won the human ear test over Sarvam's on-list neha, and it keeps ONE voice across
  kn/hi/en language switches); `PACE` tunes energy (S6: ~0.9–1.0 beats 1.2 on 8 kHz).
Set on the DEMO deployment only — never on the hospital.

### ⚠ THE FOUR THAT FAIL SILENTLY

Set these or the clinic looks fine and is not. Each one has already cost us a
deployment or was found pointing at the first clinic.

| Var | If you forget it |
|---|---|
| **`CLINIC_MODE=lean`** | **Bookings do not persist. At all.** Unset defaults to `full`, which sends the appointment to Google Calendar and writes **no `appointments` row** — no reminder, nothing on the desk. The call sounds perfect and the patient believes they are booked. There is a boot warning; it is easy to miss. `index.js` records that a deploy already shipped without this once. |
| **`GOOGLE_SHEET_ID`** | Call logging to Sheets is OFF (safe). It used to be a hardcoded literal, so every clinic wrote into the FIRST clinic's spreadsheet. Give each clinic its own sheet, or leave unset. |
| **`CLINIC_GREETING_NAME`** | The greeting says the default clinic's name. Note the word order — it is `CLINIC_GREETING_NAME`, not `GREETING_CLINIC_NAME`. This doc had it backwards until 2026-08-20, so anyone who followed it set a variable nothing reads. |
| **`CLINIC_NAME`** | The Latin name used by the tool-calling brain and the "I can only help with appointments here" line. Separate from the greeting name because that one is in the spoken script. |

**Per-clinic** (different for each):

| Var | Where | Notes |
|---|---|---|
| `DATABASE_URL` | both | this clinic's own DB |
| `CLINIC_ID_UUID` | both | from step 2 |
| `CLINIC_MODE` | voice | **`lean`** — see the table above |
| `CLINIC_GREETING_NAME` | voice | spoken clinic name, in the greeting's script |
| `CLINIC_NAME` | voice | clinic name in Latin |
| `GOOGLE_SHEET_ID` | voice | this clinic's own spreadsheet (omit = Sheets off) |
| `CLINIC_ADDRESS` | voice | what Ritu says |
| `EXOTEL_PHONE_NUMBER` | voice | this clinic's DID |
| `META_PHONE_NUMBER_ID` | voice | this clinic's WhatsApp number (if on) |
| `MEDIA_STREAM_SECRET` | voice | optional WS hard-gate (also in the Exotel URL) |
| `DESK_PASSWORD` | dashboard | this clinic's login — **strong/unique** |
| `SESSION_SECRET` | dashboard | **unique per clinic** (don't reuse — isolates sessions) |
| `NODE_ENV` | both | `production` |

---

## Shipping a fix to all clinics
Push to GitHub → every clinic's Railway service auto-deploys → each one **auto-migrates its
own DB** on boot. One push, all clinics updated. (A bad migration blocks *that* deploy
from starting — fail-safe — so it can't run new code on an un-migrated DB.)

## When to revisit (silo → pool)
This is great to ~10–20 clinics. If idle infra cost or per-clinic provisioning starts to
hurt, or you want one cross-clinic admin/billing view, migrate to the shared multi-tenant
model — the schema is already `clinic_id`-keyed, so the door stays open.
