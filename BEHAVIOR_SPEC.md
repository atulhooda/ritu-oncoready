# OncoReady behavior spec

What the system does, stated as rules that code and tests must agree with. When behavior changes,
update this file in the same commit.

## Scoring

Implemented in `backend/app/scoring/engine.py` (rules) and `backend/app/scoring/service.py`
(loading inputs, storing results). Engine version: **`score-v1`**.

### Inputs

1. **Answer key.** The case's highest-version answer key with status `final`. Each rubric item has a
   `category`, a `description`, a `weight` (> 0, two decimals) and an `is_critical` flag.
2. **Brief.** The resident's submitted readiness brief. It has five fixed sections: key changes
   since last visit, pending investigations, discrepancies noticed, treatment history, red flags.
3. **Match verdicts.** At most one `brief_item_matches` row per rubric item. Each row has:
   - the matcher's verdict (`matched`), plus the evidence quote and its section;
   - optionally, a faculty override (`override_matched` plus a required comment).

### Matching (produces the verdicts; not part of the score arithmetic)

- An LLM proposes `(rubric item id, quote)` pairs. A proposal is accepted only if the quote
  occurs verbatim in the brief text. Whitespace differences are ignored, but case, punctuation
  and words must match exactly. The stored evidence is the brief's own text, not the LLM's copy.
- These proposals are rejected:
  - the quote is not in the brief (`quote_not_in_brief`);
  - the rubric id is unknown;
  - the proposal is malformed.

  Rejections never create a match. Rejected quotes are kept on the item's row as
  `rejected_evidence`, for faculty to see.
- If several quotes are accepted for one item, the first one is the evidence.
- A rubric item with no accepted quote has `matched = false`.
- Re-running matching updates the matcher's fields and keeps any faculty override.

### Effective verdict for each rubric item

| Situation | Effective `matched` | `source` |
|---|---|---|
| Faculty override set | `override_matched` | `override` |
| Matcher row, no override | `matched` | `matcher` |
| No row for the item | `false` | `none` |

### Arithmetic

- `points_possible` = sum of all rubric item weights.
- `points_earned` = sum of weights of items whose effective verdict is matched.
- `critical_missed` = number of items with `is_critical` whose effective verdict is not matched.
- `percent` = `points_earned × 100 / points_possible`, rounded half-up to 2 decimals. It is `0.00`
  if `points_possible` is 0.
- All arithmetic uses `Decimal`; weights are rounded half-up to 2 decimals first.
- There is no pass/fail threshold and no penalty for extra content. Critical misses are reported
  separately and do not reduce `points_earned`.

### Stored result (`scores` row)

There is one row per `(brief, answer key, engine version)`. Recomputing updates that row in place.

- Columns: `points_earned`, `points_possible`, `critical_missed`, `scoring_version` (= engine version).
- `details` fields:
  - `engine_version` and `inputs_sha256`. The hash covers `[item id, weight, is_critical, effective matched]` for each item, in rubric order.
  - `points_earned`, `points_possible` and `percent`, as decimal strings; `critical_missed`.
  - `items[]`, in rubric order (`position`, then id). Each item has:
    - `rubric_item_id`, `category`, `description`, `weight`, `is_critical`;
    - `matched`, `source`, `matcher_matched`;
    - `evidence` and `evidence_section` (only when matched);
    - `override_comment` (only when overridden).
  - `by_category{}`, with `possible`, `earned`, `matched`, `missed` and `critical_missed`.

### Determinism

- The score is a pure function of the rubric items and the effective verdicts. It does not
  depend on time, randomness, LLM calls or input order. The same input always gives the same
  `details` (including `inputs_sha256`) and the same columns.
- The LLM affects the score only through verdicts it proposes. Those verdicts are stored, so
  recomputing never calls the LLM again.

### Overrides

- Faculty (or admin) can set any item to matched or not matched. A non-empty comment is required.
- An optional evidence quote may be given. If given, it must occur in the brief, using the same
  rule as matching.
- Setting or clearing an override recomputes and stores the score immediately.
- Clearing an override restores the matcher's verdict. The override author and time are recorded.

### When a score is computed

- After the resident submits: matching runs, then scoring, as one Celery task. The brief status
  goes `submitted → scored`, or `scoring_failed` with `scoring_error`.
- After any override change.

### Versioning

Any change to these rules requires a new `ENGINE_VERSION`. Scores from older versions are kept
(the version is part of the row's identity), and faculty views read the current version.

### Related rules

- **Timeline lock:** residents cannot read a case's timeline or OCR text until their own brief
  for that case is submitted. The API enforces this with 403, not just the UI. Raw page images
  are always visible.
- **Brief editing:** a resident has one brief per case. It can be edited while it is a draft and
  becomes read-only once submitted.
- **Who sees drafts:** faculty never see drafts.

## Patient intake (patient → Ritu → doctor)

Implemented in `backend/app/intake/`, `backend/app/api/patient.py`, `backend/app/api/doctor.py`
and `backend/app/api/integrations.py`. Patients are **demo personas**; real patient data is still
not allowed.

### Profile

- Each patient has exactly one intake case, created on first use. Their sessions, records and
  summary all hang off it.

### Patient sign-up (clinic link, phone + one-time code)

- **Clinics.** Each clinic (org) has a join code, e.g. `CCC`, and patients join at `/join/<code>`.
  Sign-up is closed until the clinic opens it. Create a clinic and its first doctor with
  `python -m app.cli create-clinic` (or the `BOOTSTRAP_*` variables on Railway). The synthetic demo
  org's code is `DEMO`.
- **Codes.** 6 digits, valid 5 minutes, one use; only an HMAC of the code is stored. A new code
  replaces the previous one. Limits: 5 codes per number per clinic per hour, and 5 wrong tries per
  code (after that even the right code is refused). Codes are per clinic.
- **Numbers.** Indian mobiles (6-9, 10 digits; `+91`, `0` or `91` prefixes accepted) or any
  E.164 number with another country code, stored as E.164.
- **Sign-in vs sign-up.** After a correct code, a number that already has a patient account at
  this clinic is signed in. A new number gets a 15-minute sign-up token (bound to the clinic; not a
  login token) and gives a name and agrees that this is a pilot with test accounts only.
- **Patient ID.** Each new patient gets an OncoReady ID like `OR-7K3F-9Q2D` (8 random characters
  without I, L, O, U), unique across all clinics, shown on their profile and to doctors.
- **WhatsApp (free).** When `WHATSAPP_NUMBER` and `WHATSAPP_APP_SECRET` are set, the page offers
  "Verify on WhatsApp" first. The patient sends `JOIN <clinic code> <6 digits>` (opened ready-made
  through a wa.me link) from their own WhatsApp. `POST /integrations/whatsapp/webhook` accepts only
  calls signed with the Meta app secret (`X-Hub-Signature-256`). A message confirms the newest open
  WhatsApp challenge for the sender's own number at that clinic, if the code matches; same expiry,
  attempt and hourly limits as SMS codes. The page polls with its challenge id and then continues
  as after an SMS code. Optional free reply "verified" inside the 24-hour service window. WhatsApp
  and SMS challenges are separate: a code from one does not work in the other.
- **SMS.** MSG91 when `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` are set. Otherwise demo mode: no
  SMS is sent and the code is returned to the page, which shows it labelled as demo. Demo mode is
  for test accounts only.
- **Staff** keep signing in with organization, email and password. Phone-only patients cannot.

### DigiLocker (verified identity, document import)

- **Flow.** OAuth 2.0 authorization code with PKCE (S256), as DigiLocker requires
  (`app/identity/digilocker.py`, Meri Pehchaan Requester API v2.4). The state and PKCE verifier
  are kept in Redis for 10 minutes, are good for one use, and belong to one patient. The token
  is kept in Redis for at most 15 minutes, never in the database.
- **Identity.** Name, date of birth (DDMMYYYY) and sex (M/F/T) from DigiLocker's token response
  are stored on the profile as the verified identity (`identity_*`), with when and how it was
  verified. Date of birth and sex on the profile are filled from it. Doctors see it in the report.
- **Documents.** Issued documents and the patient's own DigiLocker uploads are listed. A PDF or
  image can be added to "My records"; it goes through the same pipeline as an upload, and the same
  DigiLocker document can be imported once per patient (`source_documents.external_ref`).
- **Live vs demo.** Live needs `DIGILOCKER_CLIENT_ID`, `DIGILOCKER_CLIENT_SECRET`,
  `DIGILOCKER_REDIRECT_URI` (the frontend's `/patient/digilocker`) **and** `REAL_PATIENT_DATA=true`,
  because DigiLocker returns real Aadhaar-backed identity (rule 2). Otherwise demo: no request
  leaves the server, a labelled stand-in consent screen is shown, the identity is the patient's own
  entries marked "DigiLocker demo, not a real check", and the documents are synthetic seed PDFs.

### ABHA (health ID) link

- **Linking.** On Profile, the patient enters their 14-digit ABHA number. ABDM sends an OTP to the
  mobile linked with it; the patient enters it. The link is stored only when ABDM accepts the OTP
  and returns the same ABHA number that was typed. Only the last four digits are stored
  (`XX-XXXX-XXXX-9012`), with the ABHA address and name ABDM returned, the time and how it was checked.
- **Sandbox only.** `app/identity/abdm.py` is the only module that calls ABDM and refuses any host
  that is not an ABDM sandbox host (rule 2: synthetic personas only). Credentials come from
  `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`.
- **Demo mode.** Without credentials, no request leaves the server: any 14-digit number is
  accepted with OTP `123456`, and the link is marked "demo" everywhere it is shown.
- **Who sees it.** The patient (Profile), and the doctor (report particulars, inbox badge:
  "ABHA verified" for the sandbox, "ABHA (demo)" for demo links). Unlinking clears it.

### Doctor's professional details

- On **My profile** (`/doctor/profile`) a doctor adds their HPR ID (14 digits, ABDM Healthcare
  Professionals Registry), council registration number, medical council and qualifications.
- They are **self-declared**: not checked against HPR or a council register yet, and every report
  says "self-declared". Each report shows them under "Prepared for".
- The inbox asks the doctor to add them until an HPR ID or registration number is saved.

### Patient pages

Patients see four destinations: **Check-in** (`/patient`), **Diary** (`/patient/diary`, check-ins
between visits), **My records** (`/patient/records`) and **Profile** (`/patient/profile`). On phones these are a bottom tab bar.

Check-in is one guided flow of four steps, shown as a stepper. Every step can be opened directly,
and each finished step shows a check.

1. **About you:** patient-reported details. Date of birth, sex and cancer type are needed to finish
   this step. Age is worked out from the date of birth. Dates must be in the past. The language must
   be one of Ritu's 11 codes; Ritu starts in it and follows the patient's language.
2. **Talk to Ritu:** what Ritu does, that answers go only to the care team, and that Ritu gives no
   medical advice, all shown before the session starts. The step is done once a summarized session
   exists.
3. **Earlier records:** uploads. The step is done when there is at least one record, or the patient
   chose "I don't have any records", or the check-in has been sent.
4. **Review & send:** everything on one page, with Edit links, then "Send to my care team". This
   needs a summarized session.

After sending, Check-in shows "You're ready for your visit", what happens next, and "Start a new session": the Talk to Ritu step without the last summary, for a fresh pre-visit conversation (shared automatically, earlier ones kept). The old
`/patient/session` and `/patient/send` addresses redirect into steps 2 and 4.

Doctors see the details, labeled self-reported, only once the patient has sent their check-in.

### Session

- **Start.** "Start session" creates an `intake_session`. In `ritu` mode, OncoReady asks Ritu for a
  browser session and gives the browser a short-lived `ws_url` and `token`. In `simulator` mode
  (no Ritu configured), the browser shows the same script and the patient types their answers.
- **Script.** Built from the patient's profile (`backend/app/voice/script.py`; the full list for
  clinical review is `docs/INTAKE_QUESTIONS.md`). Ritu must not diagnose or advise.
- **Statuses.** A session goes `created → in_progress → completed` (transcript stored) `→ summarized`
  (facts extracted). It can also end as `failed` or `expired`; these carry `error`.
- **Recording the transcript.** It is stored once. Repeat deliveries are ignored, and it must
  contain at least one patient turn.
- **Ritu callbacks.** They need a valid HMAC signature less than 5 minutes old, and the
  `session_id` must match the one Ritu returned when the session started.

### Summary

- **Extraction.** The LLM proposes facts in five sections: current symptoms, current medicines,
  allergies, past history, previous records mentioned. Each fact has a patient turn index and a
  quote.
- **Validation.** A fact is kept only if that turn is a patient turn and the quote matches it
  (rapidfuzz ≥ 0.85). The stored quote is the patient's own text. Rejected candidates are kept on
  the session as `rejected_facts`.
- **Rendering.** The summary is built in code, with no LLM. It always lists the five sections in the
  same order, with facts ordered by turn. Each fact has a short label, optional details, and the
  patient's quote with its turn number. It includes the full transcript. It never contains a
  diagnosis, a cause, or advice.

### Check-ins between visits

- **What it is.** A short conversation with Ritu (`kind = check_in`), separate from the pre-visit
  history (`kind = pre_visit`). Suggested every 2–3 days and the day after each treatment while on
  treatment, otherwise weekly or whenever something changes. There are no reminders yet.
- **Script** (`build_check_in_script`). How they have been and what is new; a follow-up of up to 4
  symptoms reported before (urgent ones and the highest scores first): better, same or worse, and
  0–10 now; the warning signs (fever or chills, bleeding, breathing, confusion or fainting);
  treatment and missed doses (only when on treatment or status unknown); anything else. Ritu is
  told what was reported last time, so it does not re-ask, and gets its own framing and opening line.
- **Extraction.** The same rules and validation as the pre-visit history. For a check-in, the
  extractor is given the labels reported before and asked to reuse them, so one symptom lines up
  across conversations. Absences ("no bleeding") are not stored as facts.
- **Urgent signs.** Matched in code (`app/intake/urgent.py`) on each fact's label and details:
  coughing or vomiting blood and other bleeding, fever or chills, chest pain, confusion, fainting or
  seizures, self-harm, severe breathlessness. The patient sees "If this is happening now, contact
  your care team or emergency services" on their latest check-in; Ritu says the same during the call.
- **Symptom course.** Built in code: each current symptom (matched by label, case-insensitive)
  across the last 8 conversations of either kind, oldest to newest, with the patient's 0–10 score
  and trend. A dash means not mentioned that time, never "resolved". Urgent rows first, then the
  most recently mentioned. Both the patient (Diary) and the doctor see it.
- **Sharing.** Check-ins reach the doctor once the profile has been sent, like records. A check-in
  never replaces the pre-visit history the patient reviews, and cannot be sent on its own.
- **Doctor.** A Check-ins tab with the symptom course (click a date to open that conversation) and
  each check-in as a report. The inbox shows the last check-in date, flags urgent signs from the
  latest check-in, and sorts those patients first.

### Records

- **Uploading.** One record per upload: a PDF, a photo, or up to 20 photos saved as one document
  (photograph a report page by page). Each file is 20 MB max. Photos are turned upright using the
  phone's rotation flag, then converted into a PDF before the pipeline (OCR, extraction with page
  citations, pending tests, discrepancies, flags).
- **Removing.** A patient can remove their own records, with a confirm step. This deletes the file,
  its page images and everything read from it, and recomputes pending tests and discrepancies.

### Recording

- **Consent.** Before a voice session the patient chooses whether to record the audio for their care
  team (on by default, can be unticked). Typed sessions never record. The server refuses an upload
  for a session without consent, and the database enforces it too.
- **What is recorded.** The browser records both voices (the patient's microphone and Ritu as heard)
  and uploads them when the session ends.
- **Who can listen.** Doctors can play it, for sent check-ins only.

### Sending to the doctor

- **Sending.** "Send to doctor" sets `published_at`, and requires at least one summarized session.
- **What the doctor sees.** Doctors in the org see sent profiles only: every summarized
  conversation (newest first), each with its transcript, plus every record and the record timeline.
  The inbox lists current symptoms from all conversations, deduplicated and newest first. A later
  "nothing new" conversation never hides an earlier one; the patient page opens on the newest
  conversation that has content, and notes it when the latest one reported nothing new. The patient
  sees and reviews their latest conversation. Records uploaded after sending are visible too.
- **Who sees what.** Patients see only their own profile. Residents and faculty never see intake
  cases, and doctors never see training cases.

## Records assistant (doctor only)

RITU AI Assistant: a floating chat / voice panel on the doctor's dashboard that answers questions
about the patient on screen from that patient's records. It is a retrieval tool, not a diagnostic
or treatment tool. Code: `backend/app/assistant/`, `frontend/components/RituAssistant.tsx`.

- **Scope.** `POST /doctor/patients/{case_id}/assistant` with `{question}`. Access is checked
  with `visible_case_or_404` (doctor, same org, sent profile; else 404; other roles 403). The
  corpus is built per request from repositories filtered by that case. Nothing is stored on the
  server; the browser keeps the conversation per patient and starts a new one on patient change.
- **What is searched.** Extracted record facts, every OCR'd page line (so facts the summary or
  the extractor left out are still found), pending tests, and patient-reported facts from Ritu
  conversations (labelled "Reported by the patient to Ritu (not a clinical observation)").
- **Measurements, in code** (pulse, blood pressure, temperature, weight, hemoglobin, SpO2, LVEF).
  Values and units are read from record text (`measures.py`) and from extracted values; one
  reading per page and value, dated if any copy is dated. Date: written with the value, else the
  document's date (shown as such on the source). Question dates ("yesterday", "three months ago",
  "on 10 January", "in March 2026") are resolved in the clinic time zone; "N months ago" matches
  within ±15 days per month (max ±45). "Compare" without a date: previous vs latest. With a date
  and "latest": that one vs latest. No reading in the window: "I couldn't find … recorded …",
  then the nearest dated reading. Differences are computed only for the same unit (blood
  pressure: systolic and diastolic separately); otherwise "The units differ … not compared".
  Two different values on one date are both shown with a conflict note.
- **Pending tests, in code**: tests ordered with no result (`pending_tests`).
- **Other questions.** Lexical retrieval (local, per case) offers up to 40 items to the LLM,
  which may only return item ids plus quotes. A quote is kept only if it aligns (rapidfuzz ≥
  0.85) with that item; ids not offered are dropped. The answer shows the WHOLE source sentence
  of each kept item (never the fragment), oldest first, documented before patient-reported.
  Nothing kept: "I couldn't find this in the available records."
- **Conflicts.** Allergy statements that are negated ("no known drug allergies") and named
  ("penicillin") are a conflict in code; the LLM may also flag one. All statements are shown with
  dates and sources and none is chosen.
- **Untrusted text.** Record text is data. It is shown, never obeyed; a line addressed to an AI
  ("ignore previous instructions", "note to AI") is flagged when shown.
- **Without an LLM**: open questions fall back to the top 5 keyword matches, labelled as such.
- **Sources.** Each line cites numbered sources: file, page, date (and what that date is), and the
  verbatim text. Clicking opens the document viewer at that page with the text shown above it
  (OCR word positions are not stored, so the passage is not drawn on the page image), or the
  conversation turn.
- **Voice.** Recognition: the browser's (Chrome / Edge, which send audio to their speech service;
  not offline), a prototype fallback. The transcript is shown for checking before the answer.
  Speaking: `POST /doctor/assistant/speech` (doctors only, ≤ 2000 chars) → Ritu `/v1/speech`
  (HMAC-signed) → Sarvam bulbul:v3 in the clinic's Ritu voice, 24 kHz WAV, long text split at
  sentence ends. If Ritu is not connected (503) or fails, the browser's own voice is used and
  labelled. Play / pause / stop; one answer plays at a time.
