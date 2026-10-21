# Ritu voice ↔ OncoReady integration

**Status: built on both sides and wired end to end. Real voice needs two API keys.**

- **OncoReady:** `backend/app/voice/client.py`, `backend/app/api/integrations.py`,
  `frontend/lib/ritu-voice.ts`
- **Ritu** (`../ritu voice`, commit `5edb8b2`): `oncoreadyIntake.js`, plus hooks in `index.js` and
  `callHandler.js`, with tests in `tests/test-oncoready-intake.js`.

The live wiring was tested, without speech, inside Docker:
- OncoReady creates the session on Ritu.
- The browser token is accepted once, and a replay is refused.
- Ritu runs the intake session.
- The signed result comes back, and OncoReady records it.

Speech (Sarvam) and the LLM are the only untested parts, because they need real keys.

## Turning on real voice (3 steps)

1. In `../ritu voice/.env`, fill in `SARVAM_API_KEY` and `GEMINI_API_KEY`.
   For Groq instead, set `GROQ_API_KEY` and `LLM_PRIMARY_PROVIDER=groq`.
   The OncoReady secret and the other settings are already there.
2. In `ritu-oncoready/.env`, uncomment the three `RITU_*` / `PUBLIC_API_URL` lines.
3. Run:
   ```
   docker compose --profile voice up -d --build
   docker compose up -d --force-recreate backend worker
   ```

Then open a patient's **Talk to Ritu** page. The "simulator" label disappears, and "Start session"
asks for the microphone. Ritu speaks the language set in the patient's profile.

Browsers only allow the microphone on `localhost` or HTTPS. For a demo on another machine, serve
OncoReady over `https://`, serve Ritu over `wss://`, and set `ONCOREADY_PUBLIC_WS_BASE` to that
`wss://` address.

## How Ritu handles an intake session (what changed in Ritu)

- **`POST /v1/browser-sessions`:** checks the HMAC signature and issues a token. The token works
  once and expires after 2 minutes.
- **`/media-stream`:** accepts that token in place of the Exotel `account_sid` (phone calls still
  need the `account_sid`).
- **Intake mode in `CallHandler`:**
  - **Prompt:** OncoReady's script, not the booking receptionist.
  - **Language:** pinned to the requested one, with a greeting the model writes in that language.
  - **Off:** booking actions, speculative generation, and the booking-only questions.
  - **Ending:** `END_CALL` ends the session.
  - **Still on, every turn:** the emergency detector, medical-advice deflection and
    sensitive-data refusal.
- **`endCall`:** sends the signed transcript to OncoReady, retrying on failure. It does not write
  the clinic's call log, patient row, Sheet or WhatsApp, and does not send the emergency staff
  alert. OncoReady receives `emergency: true` instead.

## Where Ritu was before this work

Based on a read-only review of `../ritu voice` (`engageo-server-v2`). Paths are relative to that repo.

| Topic | Today | Reference |
|---|---|---|
| Call direction | **Inbound only.** Exotel Voicebot opens `WS /media-stream`; nothing in the code dials out. | `index.js:89`, `index.js:139-232` |
| Per-call input | Only `callSid`, `From`, `To`, `secret` are read from the stream `start` event (`custom_parameters`). | `index.js:160-211` |
| System prompt / flow | `buildSystemPrompt(context)`: one hard-coded receptionist prompt for booking appointments. The flow is numbered steps inside the prompt, and the model ends its replies with markers such as `BOOK_APPOINTMENT` and `END_CALL`, which the code acts on. Values filled in come from deploy-level env (one clinic per deploy) and from the DB roster. | `brain-lean.js:685`, `brain-lean.js:767-793` |
| Greeting | Fixed per-language inbound "how can I help" text. | `callHandler.js` `GREETING_TEXTS` |
| Language | Auto-detected, or forced per deploy (`FORCE_LANG`). Not set per call. | `callHandler.js:2724-2735` |
| After the call | `endCall()` classifies the outcome and inserts one row into `calls`, including `transcript` (JSONB `[{role: patient\|ritu\|system, text, time}]`). Recording URL is polled from Exotel for up to ~3 min. | `callHandler.js:4783`, `db.js:307-339`, `exotelRecording.js` |
| Summary | **None.** No LLM summary of a call; only outcome codes and diagnostics. | `callOutcome.js` |
| Outbound notifications | Google Sheet row, WhatsApp booking confirmation, and an n8n webhook for emergencies only. **No transcript or completion callback.** | `crm.js`, `callHandler.js:4713-4723` |
| HTTP API | `/health`, the WhatsApp webhook, and a stub `GET /exotel/call-end`. Nothing a third party could call. | `index.js:76-83`, `index.js:306` |

So everything below is new on the Ritu side.

## Chosen design: browser sessions

Audio goes **browser ↔ Ritu directly**; OncoReady never relays audio. OncoReady only creates
the session (server-to-server) and receives the transcript.

```
Patient browser ──(1) POST /me/sessions──────────────► OncoReady
                                                        │ (2) POST /v1/browser-sessions (HMAC)
                                                        ▼
                                                      Ritu ── returns {session_id, ws_url, token}
Patient browser ◄─(3) {ws_url, token}────────────────── OncoReady
Patient browser ══(4) WSS audio (existing /media-stream protocol)══► Ritu
                                                      Ritu ──(5) POST callback (HMAC) ──► OncoReady
```

### Ritu endpoint: `POST /v1/browser-sessions`

Signed with the same HMAC headers as below. Body:

```json
{
  "external_ref": "oncoready:<org_id>:<session_id>",
  "language": "en",
  "context": {"patient_display_name": "Maria Placeholder", "clinic_display_name": "OncoReady demo clinic"},
  "script": { "purpose": "pre_visit_intake", "rules": ["..."], "steps": [
      {"id": "current_symptoms", "goal": "...", "prompts": ["..."]},
      {"id": "previous_records", "goal": "...", "prompts": ["..."]}
  ], "closing": "..." },
  "callback_url": "https://<oncoready>/integrations/ritu/sessions",
  "max_duration_s": 600
}
```

The script comes from `backend/app/voice/script.py`. OncoReady owns *what* is asked, and Ritu
owns *how* it is said.

Response: `201 {"session_id": "rs_…", "ws_url": "wss://<ritu>/media-stream?sample-rate=8000",
"token": "<single-use>", "expires_at": "<ISO, ~2 min>"}`.

### Audio protocol: the existing `/media-stream` protocol (as in `public/test-harness.html`)

- The browser sends `{"event":"connected"}`, then a `start` message:
  `{"event":"start","start":{"streamSid","callSid","customParameters":{"session_token":"<token>","callSource":"oncoready_browser"}}}`
- Microphone audio goes up as `{"event":"media","media":{"payload":"<base64 PCM16 mono 8 kHz>"}}`.
- Ritu's audio comes back as `media` with the same encoding. Ritu also sends `mark` (the browser echoes it once playback reaches that point) and `clear` (flush playback).
- `{"event":"stop"}` ends the session from the browser. Ritu ends it after the closing line.

### Callback to OncoReady: `POST {callback_url}`

Same shape as the phone webhook below. OncoReady reads `session_id`, `external_ref`, `status`
(`completed | failed | no_input | expired | canceled`), `started_at`, `ended_at`, and
`transcript[{role, text, time}]`. It verifies the HMAC signature (5-minute window) and ignores
duplicate deliveries.

### What Ritu had to change for browser sessions (done)

1. **Session token gate.** Today a `start` without the clinic's Exotel `account_sid` is refused
   (`index.js:154`, fail-closed). That's correct for phone calls, but a browser can't send one.
   Ritu should accept a `start` that carries a valid, unexpired, single-use `session_token` that
   it issued itself, and keep the `account_sid` rule for Exotel.
2. **Pre-visit intake mode.** When a session has an intake script, Ritu should use it instead of
   `buildSystemPrompt` (the booking receptionist). That means: an outbound-style greeting, the two
   steps in order, no booking markers, and the patient's language.
3. **Completion callback.** In `endCall()`, POST the signed result to `callback_url` and retry on
   failure.
4. **Exclusions.** Leave these sessions out of the missed-call WhatsApp recovery and out of the
   returning-caller lookup by phone.

## Phone-call API (alternative, kept for later)

Three pieces: start a call, get a call, and a completion webhook. All JSON over HTTPS.

### Auth (both directions)

- Shared secret per integration. Each request carries:
  - `X-Ritu-Timestamp`: unix seconds
  - `X-Ritu-Signature`: `hex(HMAC_SHA256(secret, timestamp + "." + raw_body))`
- Receivers reject requests whose timestamp is more than 5 minutes off, or whose signature fails.
- The same scheme signs the webhook Ritu sends to OncoReady, so OncoReady can verify it.

### 1. Start a call: `POST /v1/previsit-calls`

```json
{
  "external_ref": "oncoready:org_123:case_456:visit_789",
  "to_phone": "+91XXXXXXXXXX",
  "language": "en",
  "context": {
    "patient_display_name": "Asha",
    "clinic_display_name": "Synthetic Oncology Clinic",
    "appointment_at": "2026-11-03T10:30:00+05:30"
  },
  "script": {
    "purpose": "pre_visit_intake",
    "questions": [
      {"id": "q1", "text": "Have you had any new symptoms since your last visit?"},
      {"id": "q2", "text": "Are you still taking all your current medicines?"},
      {"id": "q3", "text": "Have you had any tests done at another hospital?"}
    ]
  },
  "callback_url": "https://oncoready.example.com/v1/voice/callbacks",
  "max_duration_s": 420
}
```

- `external_ref` is OncoReady's id for the call request and the **idempotency key**: a repeat POST with the same value returns the existing call instead of dialing again.
- **OncoReady sends structured questions, not a raw system prompt.** Ritu keeps ownership of its voice prompt and supplies:
  - turn-taking
  - language handling
  - recording disclosure
  - silence and hang-up handling
  - the rule that the call must not give medical advice

  This keeps prompt injection and call behaviour on Ritu's side. It also matches OncoReady's "no diagnosis or treatment advice" rule.
- Response: `202 {"call_id": "rc_…", "status": "queued"}`.

### 2. Get a call: `GET /v1/previsit-calls/{call_id}`

Returns the same shape as the webhook below. OncoReady uses it as a fallback when a webhook is missed, and for reconciliation.

### 3. Completion webhook: `POST {callback_url}`

Ritu sends this once the call reaches a final state. Non-2xx responses are retried with backoff (e.g. 1m, 5m, 30m, 2h).

```json
{
  "call_id": "rc_…",
  "external_ref": "oncoready:org_123:case_456:visit_789",
  "status": "completed",
  "started_at": "2026-11-01T09:00:04Z",
  "ended_at": "2026-11-01T09:04:51Z",
  "duration_s": 287,
  "language": "en",
  "transcript": [
    {"turn": 0, "role": "ritu", "text": "…", "time": "2026-11-01T09:00:05Z"},
    {"turn": 1, "role": "patient", "text": "…", "time": "2026-11-01T09:00:12Z"}
  ],
  "questions_asked": ["q1", "q2", "q3"],
  "recording_available": true
}
```

- `status` values: `completed | no_answer | busy | failed | canceled | voicemail`. While a call is in flight, `GET` also returns `queued | ringing | in_progress`.
- `transcript` keeps Ritu's existing `{role, text, time}` turns and adds a stable `turn` index. OncoReady treats each turn like a page: any fact extracted from a call stores `turn` and the verbatim text span (CLAUDE.md rule 5).
- **No summary field.** Ritu doesn't generate one today, and OncoReady's rules allow LLM use only for extraction behind its own client. OncoReady extracts from the transcript itself. A summary can be added later as an optional field without breaking anything.
- The recording itself stays in Ritu/Exotel. `recording_available` only says whether one exists. Recordings arrive minutes after the call ends, so they are not in this payload.

### Optional: `POST /v1/previsit-calls/{call_id}/cancel`

Cancels a call that is still `queued`. Can be deferred.

## What Ritu would need to build (for its team to scope)

1. **Outbound dial.** Call Exotel's Calls/connect API to bridge `to_phone` to the Voicebot applet. Ritu already has config for this (`EXOTEL_PHONE_NUMBER`, `EXOTEL_APP_ID`) that nothing uses yet.
2. **Hand the call request to the live call.** Store the request under `call_id` and pass `call_id` through Exotel `CustomField` → `start.custom_parameters`. `index.js:160` already reads custom parameters.
3. **Pre-visit mode in the brain.** Add a second prompt/flow path next to `buildSystemPrompt`:
   - an outbound greeting
   - the asked questions
   - per-call language
   - no booking markers
4. **Call status.** Map Exotel StatusCallback to the states above, so `/exotel/call-end` stops being a stub. Add `direction` and request-id columns to `calls`.
5. **Completion hook** in `endCall()` → signed webhook with retry. Today the `calls` insert uses `ON CONFLICT DO NOTHING`, so the status/outcome write path needs adjusting for outbound.
6. **Leave outbound calls out of the inbound-only features**:
   - the missed-call WhatsApp recovery cron (`scheduler.js:136`)
   - the returning-caller lookup
7. **API auth** (HMAC above) and an OncoReady-specific secret.

## What OncoReady would need (later, not now)

- One client module for Ritu (`app/voice/client.py`) and a webhook endpoint that verifies the HMAC signature.
- Tables, all with `org_id`: `voice_calls` (request, status, `external_ref`) and `call_transcript_turns`.
- Extraction from turns uses the existing LLM client and provenance rules, with the turn index in place of the page.

## Open decisions before building

1. **Real patient data.** A call to a real patient produces a real PHI transcript, and CLAUDE.md rule 2 currently forbids real patient data in OncoReady. Until that rule changes deliberately (with consent, retention and access controls), this integration should be used only with test phone numbers and synthetic personas.
2. **Consent and recording disclosure.** Ritu's `RECORDING_NOTICE` is a disclosure line, not consent, and covers 5 languages. Outbound calls need explicit consent capture.
3. **Tenancy.** Ritu runs one clinic per deploy. Decide whether OncoReady calls go through a dedicated Ritu deploy or through per-request clinic identity.
4. **Retention.** Ritu has no transcript purge path today. Agree how long each side keeps transcripts.
