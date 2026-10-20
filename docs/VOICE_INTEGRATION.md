# Ritu voice ↔ OncoReady: minimal integration API

Status: **proposal, nothing built.** OncoReady does not implement voice (CLAUDE.md rule 7);
it calls Ritu over HTTP and receives results back.

Goal: OncoReady triggers an outbound **pre-visit call** to a patient, and receives the
**transcript** when the call ends.

## Where Ritu is today

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

## Proposed API (Ritu exposes, OncoReady calls)

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
