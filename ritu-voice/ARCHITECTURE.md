# Engageo — current design and configuration

**Written 2026-08-04.** Every line is marked VERIFIED (I ran it and saw the result),
DOC (vendor documentation, with a link), or ASSUMED (believed, not checked).
Anything unmarked is ASSUMED. This convention exists because four separate wrong
conclusions in one day came from treating a local file as if it were production.

---

## THE RULE THAT MATTERS MOST

> **A local `.env` is not production.** Production's configuration lives in Railway
> and Vercel environment variables. They are different files, they drift, and the
> drift is invisible.

VERIFIED, four times in one day, each one costing real time:

| what I read locally | what production actually had | cost |
|---|---|---|
| `STT_MODE=transcribe`, pinned `hi-IN`, endpointing untuned | `codemix`, `unknown`, 10-of-14 | a whole eval measured a system nobody runs |
| `META_ACCESS_TOKEN` expired 9 July | a valid System User token, never expires | I reported WhatsApp "dead for a month" — it was fine |
| `DATABASE_URL` → roundhouse proxy | voice server used `postgres.railway.internal` | I told the founder to change it; the desk went down |
| — | — | — |

`tools/prod-config.js` (in `ritu-evals`) exists to solve this for STT/brain config:
it derives the pins from production's own **boot log** rather than any file, and
refuses to guess a value it cannot find. **The same discipline was never applied
to credentials or database URLs.** That is the open gap.

**To read production config: Railway dashboard → service → Variables.** Not the
repo. Never the repo.

---

## SERVICES

| service | repo | host | what it is |
|---|---|---|---|
| **engageo-server-v2** | `siddharthpathania/engageo-server-v2` | Railway, **Singapore** | the voice agent "Ritu" + WhatsApp receptionist |
| **ritu-desk-demo** | `siddharthpathania/ritu-desk-demo` → `demo.engageoagency.com` | Railway (was **US West** — moved) | the clinic dashboard |
| **engageo-website** | `siddharthpathania/engageo-website` → `engageoagency.com` | Vercel, **bom1 (Mumbai)** | marketing site **+ the Decentro payment proxy** |
| **Postgres ×2** | — | Railway | see the warning below |

`ritu-desk` (no `-demo`) is **DEAD**. It was an unrelated repository with no shared
git history. Verified before abandoning it that the demo repo already had
everything of value (login lockout, recordings playback, patient documents).
Do not commit to it.

---

## ⚠ TWO DATABASES — THE BIGGEST OPEN PROBLEM

VERIFIED 2026-08-04. The phone line and the dashboard are on **different Postgres
instances** (different passwords, different content):

| | voice server | desk |
|---|---|---|
| host | `postgres.railway.internal:5432` | `roundhouse.proxy.rlwy.net:50696` |
| doctors | **25** — Alka Ranade, Anand Kane, Ramesh Gokhale, Manoj Deo… | **16** — Amol Muley, Kapil Patwardhan, Sunil Nikam… |
| overlap | **one name** (Dr. Anjali Deshmukh) | |
| latest call | 30 July 2026 | 30 June 2026 |
| clinics | (unread — `.internal` is unreachable from outside Railway) | Sai Shradha (14), Smile Dental (2) |

**Consequence:** every booking Ritu makes goes into a database
`demo.engageoagency.com` never displays. The desk is showing a different clinic
from the one Ritu answers for. All the payments work built 2026-08-02/03 sits on
the **desk's** database.

**This needs deciding, not patching.** Consolidating means migrating the roster,
patients, appointments and call history deliberately — not swapping a variable.
To inspect the voice database at all, get its **public proxy URL** from Railway
(the Postgres service in the voice project → Connect → `…proxy.rlwy.net:PORT`);
`.internal` only resolves inside Railway.

---

## VOICE PIPELINE

Exotel (8 kHz PCM16) → Sarvam **saaras:v3** streaming STT → **Gemini-3.1-flash-lite**
(fallback groq) → Sarvam **bulbul:v3** TTS → Exotel.

Production config, VERIFIED by deriving it from the boot log:

```
CLINIC_MODE=lean            STT_MODE=codemix         ENABLE_MULTILINGUAL=true
STT_NEGATIVE_FRAMES_COUNT=10  STT_NEGATIVE_FRAMES_WINDOW=14
ENABLE_ROSTER_SLICE=true    ENABLE_GOOGLE_CALENDAR=false
SPEAKER=suhani              LLM_PRIMARY_PROVIDER=gemini   GREETING_LANG=mr-IN
```

- **Lean mode** = one LLM call per turn, roster preloaded into the prompt, no
  tool-calling round trip. `brain-lean.js` is the brain; `callHandler.js` is the
  call lifecycle.
- **saaras:v4 — do NOT migrate.** VERIFIED down production's own socket under
  codemix: exact tie with v3 (42/60 both arms), only real win ~40 ms of
  server-side latency against a ~1.2 s turn. The earlier "v4's scope is English
  only" argument was **refuted** — the docs are silent about v4, not negative.
- **Latency**, VERIFIED from a live call: dead-air p50 **1229 ms** =
  stt+debounce 342 + llm 555 + tts-firstbyte 267. **This is SERVER-SIDE ONLY** —
  it starts when *we* detect end-of-speech and stops when *we* hand audio to
  Exotel. The uplink and downlink are **not measured at all**. Industry figure
  for telephony is 300–500 ms, which would make it the single largest term.
  One loopback test settles it and has not been run.

## WHATSAPP

Same brain. `whatsappChannel.js` is a thin adapter onto `brain-lean`; there is no
second receptionist. `whatsappBrain.js` was deleted — it could not book and its
reschedule branch replied "done" while changing nothing.

- **Guards run before the brain** (`whatsappGuards.js`): emergency → self-harm →
  sensitive-data → medical-advice, same order as voice. Image/document captions
  included.
- **NEVER `require('./callHandler')` from the WhatsApp path.**
  `callHandler → crm → whatsapp` is a cycle and `crm.js:3` destructures at load,
  so that import silently breaks the voice path's post-call confirmation. Shared
  text lives in `safetyText.js` / `translit.js` for this reason.
  Locked by `tests/test-no-callhandler-cycle.js`.
- Templates on the WABA (VERIFIED via Graph API): `appointment_confirmation`,
  `request_previous_reports` APPROVED; `payment_request`,
  `missed_call_recovery`, `no_show_recovery` created 2026-08-03, category
  UTILITY (~₹0.14/msg; Marketing is ~7×).
- Messaging tier TIER_250 — 250 unique recipients/24h. Fine for a pilot, a
  ceiling at 50 clinics.

## PAYMENTS

**Zero commission by architecture, not by discount.** Full reasoning in
`ritu-desk-demo/PAYMENTS_PLAN.md`.

- Patient → clinic: **plain UPI, direct to the clinic's VPA.** No gateway, no
  licence question, ₹0. The dashboard generates the request and records the
  outcome; it is never the money path. Anyone pooling funds on behalf of
  merchants needs an RBI Payment Aggregator licence — that wall shapes everything.
- Clinic → Engageo (subscription): **Decentro**, because one payment per clinic
  per month makes a flat fee trivial (~₹150/mo for 50 clinics) and buys a real
  webhook.
- **Decentro accepts Indian IPs only** (VERIFIED: identical request succeeds from
  an Indian residential IP, returns a raw nginx 403 from Railway Singapore).
  Hence the proxy on the Mumbai-hosted marketing site:
  `www.engageoagency.com/api/upi/link` and `/api/upi/status`, shared-secret
  guarded, credentials held there and nowhere else. **Use the `www` host** — the
  apex 308-redirects and a redirected POST can drop custom headers.
- DOC: Decentro's minimum is **₹5**, not ₹1. v3 needs only `client_id` +
  `client_secret` (no module secret). Credential **pair 1** authenticates; pair 2
  returns 401.
- Settlement is verified against Decentro's own status API, never the callback
  body. `lib/payments/settle.ts` is the single place an invoice changes state,
  shared by the webhook and the "Check status" button so they cannot drift.

---

## DEPLOY GATES

`git push origin main` on **engageo-server-v2** triggers, in order:

1. **migration safety** — `tools/check-migration-safety.js`
2. frozen suite — `ritu-evals/suite/run-suite.js` (must say SHIP)
3. boot-smoke matrix — env-shape crash check
4. vendor-claim check — every third-party parameter cites its evidence

The hook now lives at **`githooks/pre-push`** and is installed with
`bash tools/install-hooks.sh`. Before 2026-08-03 it existed only in `.git/hooks`,
which git does not track — so it had lived on exactly one laptop and **any fresh
clone deployed completely ungated.**

**Gate 1 exists because of an outage.** `package.json` runs
`prestart: node db/migrate.js`, which wraps every unapplied migration in
BEGIN/COMMIT. `005_booking_integrity.sql` contains `CREATE INDEX CONCURRENTLY`,
which Postgres refuses in a transaction — prestart exited, `start` never ran, and
the voice line returned 502 for an hour. **All three other gates were green**,
because none of them runs prestart. The failure that removes the entire product
was the one thing unguarded.

`005` and `006` are deliberately **untracked**. They must be applied BY HAND,
outside a transaction, and recorded in `schema_migrations`. Still outstanding:
- `005` — the one-active-row-per-(patient,doctor) index `bookAppointment` relies on
- `006` — `whatsapp_dlq`, without which failed sends vanish with only a log line

**Never `git add -A` in this repo.** That is how `005` shipped.

---

## THE MEASUREMENT DISCIPLINE

Not process for its own sake — each rule was bought with a wrong conclusion.

1. **Did the test call PRODUCTION'S code, or re-walk its path?** Re-walking caused
   five false findings in one day (a mock ignoring `WHERE id`, a harness pinning
   language to turn 1, audio streamed at the wrong sample rate).
2. **n=1 is an anecdote.** An LLM is non-deterministic; "पेट दर्द books Neurology"
   was 1/1 and then 0/6.
3. **Both arms, always.** Recall alone reported saaras:v4 as +15 pp while it was
   inserting a drug the patient never said. Every precision change needs its
   recall arm on the same corpus.
4. **A check nobody has watched FAIL is not a check.** Stated as a mutation test in
   every test file in this repo.
5. **Every vendor parameter carries DOC: / MEASURED: / ASSUMED.** Gate-enforced. Born
   from a guessed Sarvam VAD setting that cut "Dolo 650" in half on a live call.

`ritu-evals/tools/claim.js` gates what I *say*, not only what the code does — five
questions before a finding is reportable. Hit rate ~62%; the "did it call
production" question alone caught seven fidelity bugs in a day.

**Known instrument gap:** `s5.drug_false_positive` runs on 4,675 sentences
containing **zero Latin characters**, so the entire English/code-mixed brand path
is invisible to it. VERIFIED: a fix removing 38 invented molecules moved that
metric by 0.00 pp. `tests/test-drug-english-words.js` is the missing arm; a
proper corpus is still owed.
