# Skin Essence — Implementation Specification

**Handoff document.** Written 26 Aug 2026 after a four-lane design pass (booking policy,
content engine, onboarding manifest, instrumentation) and an adversarial review that
raised 8 blocking and 20 material findings — every one resolved below. The implementer
has the codebase and this document, nothing else. Do not re-derive decisions; where a
choice looks odd, the rationale is beside it.

The client: **Skin Essence Cosmetic and Laser Center, Ahmedabad** (setup form signed
25 Aug, Dr. Daksha Patel). Overflow model: their Airtel SIM forwards to our Exotel DID
after ~4 rings; the desk keeps answering first. 20–50 calls/day, 8–10 reach Ritu.

---

## 0. Decisions locked (do not reopen)

From the founder:
- **D1** Emergency Part C of the form: not chased. The dermatology emergency lexicon is
  OUR clinically-sourced code work, Phase 2.
- **D2** Hours: Mon–Sat identical — 10:30–20:00, lunch 14:00–16:00 (two schedule rows
  per day). Dr. Jigisha Parekh's evening window ends 19:00. Sunday closed.
- **D3** Greeting opens in **Gujarati**. No FORCE_LANG; auto-detect stays.
- **D4** No staff-confirmation flow. Q28 void; Q54 collapses to normal booking.
- **D5** The laser row was the form's sample. Five treatments only.

From the design pass (resolutions of lane conflicts — the reasoning matters):
- **D6 — No "same-call correction" exemption.** The day-scoped unique index IS the whole
  rule: same patient + same doctor + **same day** → the existing ON CONFLICT move;
  **different day → a second row**. A caller booking two sittings in one call (the
  aesthetic use case) gets two bookings, correctly. A cross-day change-of-mind also gets
  two rows — visible on the desk and in both WhatsApp confirmations, fixable by staff.
  The rejected alternative (routing same-call re-emits through updateAppointment) was
  shown by review to silently merge two-sittings-in-one-call into one, which is worse
  and invisible. No `same_call_correction` flag exists. (Resolves blocking findings
  #4/#5.)
- **D7 — FAQ table seeds with ONE row: parking.** The form's other two E3 answers are
  absorbed by structures that already render them: hours come from `doctor_schedules`
  via the roster (a static hours string contradicts the lunch break and Jigisha's 19:00
  — defect class 1), and fees come from `doctors.fee_inr` + the new follow-up policy
  columns via a code-built FEES line. Desk-form validation (Phase 2) rejects FAQ answers
  containing money or time-ranges, pointing at the structured home.
- **D8 — `disclose_price` defaults FALSE in DDL, with a backfill `UPDATE … SET
  disclose_price = TRUE` for rows existing at migration time.** New rows fail closed (a
  forgotten flag is silent about price, never loud); existing demo-clinic rows keep
  today's behaviour byte-for-byte. Seeds always set it explicitly.
- **D9 — Launch at capacity 1/slot everywhere.** Strictly safer than the form's 2/slot;
  today's engine already behaves this way. Capacity 2 (+ Monday 1 override + daily cap
  25) is Phase 2 with the full parity test. The form's numbers are seeded into
  `clinic_policies` on day one so Phase 2 is a wiring change, not a data change.
- **D10 — Reminder offset lives in `clinic_policies.reminder_offset_minutes`** (it is a
  policy number), not on `clinics`. One home. Skin Essence: 120. Fleet default 1440.
- **D11 — Every scheduler job is individually flag-gated, flags read INSIDE the exported
  job function** (so tests can prove the gate itself). Skin Essence launch state:
  reminder ON, no-show OFF (no attendance writer exists — 52/59 demo rows are
  mismarked), post-visit followup OFF (Q63: no), missed-call-recovery OFF (Ritu already
  answers the missed calls; a text on top was never agreed). The demo clinic's env
  explicitly sets its current behaviour in the same deploy so nothing silently changes.
- **D12 — The canonical name pair.** Latin canonical: **"Skin Essence Cosmetic and
  Laser Center"** (Q58, title-cased) → `CLINIC_NAME`, Meta sender, desk. Spoken
  Gujarati rendering: **"સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટર"** → `CLINIC_GREETING_NAME`.
  "Converged" (cutover gate 9) means both derive from this documented pair — not that
  all surfaces are byte-identical across scripts.
- **D13 — Accepted launch divergences, stated rather than hidden:** (a) horizon 2 days
  is offer-side only at launch (`SLOT_SEARCH_DAYS` becomes env-readable, set 2); a
  caller explicitly demanding day 9 will be accepted by availability.js until Phase 2.
  (b) Same-day cutoff (1h before close) is Phase 2. (c) The 10-min gap governs the
  offer walk only; a caller-named off-grid time is snapped (see 1.6). Worst cases are
  clinic-tolerance issues, not safety.

---

## Phase 0 — ships first, benefits the demo clinic too

### 0.1 Scheduler job gates  *(no DDL — deployable today)*

`scheduler.js`: every cron body becomes a **named exported function**
(`runReminderJob`, `runNoShowJob`, `runFollowupJob`, `runMissedCallJob`); the
`cron.schedule` lines become one-liners calling them. First line of each job:

```js
if (process.env.<FLAG> !== 'on') return { gated: true };
```

Flags: `REMINDER_JOB` (demo+Skin Essence: on), `NOSHOW_JOB`, `FOLLOWUP_JOB`,
`MISSED_CALL_JOB` (all three: absent ⇒ OFF). `initScheduler` prints one loud line per
gated job; the no-show one explains WHY:

```
[SCHEDULER] ⚠ no-show job DISABLED: appointments.confirmed has no production writer
[SCHEDULER]   (52/59 historical rows mismarked). Set NOSHOW_JOB=on ONLY after the desk
[SCHEDULER]   attendance writer ships and calls markAppointmentConfirmed.
```

`runtimeConfig.js` gains the four booleans (recorded per call; absent ≠ zero rule).
**Demo clinic env in the same deploy:** `REMINDER_JOB=on FOLLOWUP_JOB=on
MISSED_CALL_JOB=on` (its current live behaviour), `NOSHOW_JOB` unset → the wrong
"aap nahi aa paaye" messages STOP on the demo too.

**Driven test** `tests/test-scheduler-gates-driven.js` (test-latency-split-driven
pattern: intercept `db.pool.query`): flag unset → serve a stale `confirmed=false` row →
assert **zero** UPDATE and zero send calls; flag on → the path still works. Capture
console in `initScheduler`, assert the warning. **Mutant** `MUT-NOSHOW-ALWAYS-ON`
(delete the flag check) must go red.

**Proof of done:** demo deploy log shows the SCHEDULER warnings; one evening passes
with zero new `no_show` rows (`SELECT count(*) FROM appointments WHERE
status='no_show' AND updated_at > <deploy>` = 0).

### 0.2 Migration 013 — `db/migrations/013_booking_policy.sql`

One file, this order (prestart runs it before new code starts — the swap and the code
that targets it deploy atomically):

```sql
-- 1. Policy values. Empty table = today's exact behaviour (deletion test).
CREATE TABLE clinic_policies (
  clinic_id               UUID PRIMARY KEY REFERENCES clinics(id),
  booking_horizon_days    INT  NOT NULL DEFAULT 8  CHECK (booking_horizon_days BETWEEN 0 AND 60),
  min_notice_minutes      INT  NOT NULL DEFAULT 30 CHECK (min_notice_minutes BETWEEN 0 AND 1440),
  same_day_cutoff_minutes INT  NOT NULL DEFAULT 0  CHECK (same_day_cutoff_minutes BETWEEN 0 AND 720),
  slot_capacity           INT  NOT NULL DEFAULT 1  CHECK (slot_capacity BETWEEN 1 AND 20),
  slot_capacity_by_dow    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(slot_capacity_by_dow)='object'),
  daily_cap_per_doctor    INT  CHECK (daily_cap_per_doctor BETWEEN 1 AND 200),
  gap_minutes             INT  NOT NULL DEFAULT 0  CHECK (gap_minutes BETWEEN 0 AND 120),
  default_slot_minutes    INT  CHECK (default_slot_minutes BETWEEN 5 AND 120),
  default_doctor_id       UUID REFERENCES doctors(id),
  followup_free_days      INT  CHECK (followup_free_days BETWEEN 0 AND 60),
  followup_fee_inr        INT  CHECK (followup_fee_inr >= 0),
  reminder_offset_minutes INT  NOT NULL DEFAULT 1440 CHECK (reminder_offset_minutes > 0),
  version                 INT  NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE doctors    ADD COLUMN slot_minutes INT CHECK (slot_minutes BETWEEN 5 AND 120);
ALTER TABLE treatments ADD COLUMN disclose_price BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE treatments SET disclose_price = TRUE;          -- D8 backfill: existing rows keep today's behaviour
ALTER TABLE appointments ADD COLUMN booking_evidence JSONB;

CREATE TABLE clinic_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  question TEXT NOT NULL CHECK (length(trim(question)) > 0),
  answer   TEXT NOT NULL CHECK (length(trim(answer))   > 0),
  sort_order INT NOT NULL DEFAULT 0,
  active   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uniq_faq_question_per_clinic ON clinic_faqs (clinic_id, LOWER(question)) WHERE active;

-- 2. Capacity trigger. Replaces uniq_doctor_slot's binary taken-ness.
--    Race-safe: per-doctor advisory xact lock; the second racing txn re-counts after
--    the first commits. Counts by (doctor, exact timestamp); the OFFER side books on
--    the pitch grid (bookingPolicy.snapToGrid) so Ritu's rows land on grid times.
--    REVIEW FIX folded in: exclude by patient_id, not id — a BEFORE trigger sees a
--    fresh NEW.id, so excluding by id would count the idempotent upsert's own row.
--    The day-scoped unique index below guarantees at most one same-patient row per day.
CREATE OR REPLACE FUNCTION enforce_booking_caps() RETURNS trigger AS $$
DECLARE tz TEXT; dow INT; cap INT; n INT; pol clinic_policies%ROWTYPE;
BEGIN
  IF NEW.status <> 'booked' OR NEW.is_walk_in THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bookcap:' || NEW.doctor_id::text, 0));
  SELECT * INTO pol FROM clinic_policies WHERE clinic_id = NEW.clinic_id;
  IF NOT FOUND THEN pol.slot_capacity := 1; pol.slot_capacity_by_dow := '{}'::jsonb;
                    pol.daily_cap_per_doctor := NULL; END IF;
  SELECT COALESCE(timezone,'Asia/Kolkata') INTO tz FROM clinics WHERE id = NEW.clinic_id;
  dow := EXTRACT(dow FROM (NEW.appointment_time AT TIME ZONE tz))::int;
  cap := COALESCE((pol.slot_capacity_by_dow ->> dow::text)::int, pol.slot_capacity);
  SELECT count(*) INTO n FROM appointments
   WHERE doctor_id = NEW.doctor_id AND appointment_time = NEW.appointment_time
     AND status = 'booked' AND NOT is_walk_in
     AND patient_id IS DISTINCT FROM NEW.patient_id;
  IF n >= cap THEN RAISE EXCEPTION 'slot full (% of %)', n, cap USING ERRCODE='RT001'; END IF;
  IF pol.daily_cap_per_doctor IS NOT NULL THEN
    SELECT count(*) INTO n FROM appointments
     WHERE doctor_id = NEW.doctor_id AND status='booked' AND NOT is_walk_in
       AND (appointment_time AT TIME ZONE tz)::date = (NEW.appointment_time AT TIME ZONE tz)::date
       AND patient_id IS DISTINCT FROM NEW.patient_id;
    IF n >= pol.daily_cap_per_doctor THEN
      RAISE EXCEPTION 'doctor day full (%)', n USING ERRCODE='RT002'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_booking_caps
  BEFORE INSERT OR UPDATE OF appointment_time, status, doctor_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_caps();

-- 3. THE MULTI-VISIT FIX. Day-scoped; AT TIME ZONE on timestamptz is IMMUTABLE so the
--    expression may live in an index. Literal zone acceptable under silo (29c3b9f).
CREATE UNIQUE INDEX uniq_active_patient_doctor_day
  ON appointments (clinic_id, patient_id, doctor_id,
                   ((appointment_time AT TIME ZONE 'Asia/Kolkata')::date))
  WHERE status = 'booked';

-- 4. Old indexes go LAST, same file. Between trigger-create and here nothing is
--    unguarded; between here and process start nothing runs (prestart).
DROP INDEX IF EXISTS uniq_doctor_slot;
DROP INDEX IF EXISTS uniq_active_patient_doctor;
CREATE INDEX idx_active_doctor_slot ON appointments (doctor_id, appointment_time)
  WHERE status = 'booked' AND NOT is_walk_in;
```

### 0.3 Code changes riding migration 013

- **`tools/bookAppointment.js`**
  - ON CONFLICT target (≈:247) becomes the day-scoped expression, matching the index
    exactly: `ON CONFLICT (clinic_id, patient_id, doctor_id, ((appointment_time AT TIME
    ZONE 'Asia/Kolkata')::date)) WHERE status = 'booked'`.
  - The `prev` CTE (≈:238) becomes day-scoped too, so `moved_from` never reports
    another day's row.
  - `booking_evidence` JSON is a param of the SAME insert (never a second UPDATE):
    `{ policy_version, checks:{...}, conflict_path, call_sid }`.
  - catch (≈:261): `RT001` → existing `fail_kind:'slot_taken'` re-offer; `RT002` → new
    `fail_kind:'day_full'`.
- **`tools/updateAppointment.js`** catch (≈:167–183): map `RT001`/`RT002` identically
  (review finding: its UPDATE fires the trigger too).
- **`brain-lean.js`** seven-reasons switch + `cannedLine`: new `dayFull` line
  (gu/hi/en).
- **New `tools/utils/bookingPolicy.js`** — offerWindow.js shape, pure, both-sides:
  `loadPolicy(pool, clinicId)` (defaults reproduce today; ABSENT row ≠ zeros),
  `slotPitch(policy, doctor)` = `(doctor.slot_minutes ?? policy.default_slot_minutes ??
  config.appointmentSlotMinutes) + policy.gap_minutes`, `capacityFor(policy, dow)`,
  `maxOfferDayOffset`, `meetsNotice`, `beforeSameDayCutoff`, `slotFull`, `dayFull`,
  `followupFee`, `snapToGrid(policy, doctor, minutes)` (floor to the window's pitch
  grid). Phase 0 wires **loadPolicy + snapToGrid into bookAppointment only** (accept
  snaps the caller's spoken time to the grid; the canned confirmation already speaks
  the committed row's time, so snapping is automatically honest). The rest wires in
  Phase 2.

**Driven tests** (all in `tests/`, pool-intercept pattern, each with named mutants):
- `test-multi-visit-driven.js`: two bookings, same patient+doctor, **different days** →
  two INSERTs, first row untouched (this is cutover gate 2). Same day, different time →
  the move path. Mutant `MUT-CONFLICT-DAYLESS` (restore the old conflict target) → red.
- `test-capacity-trigger.js` (integration, real Postgres via TEST_DATABASE_URL):
  cap 1 → two concurrent inserts, exactly one commits; the idempotent same-patient
  re-book does NOT count itself (review regression); with a seeded `clinic_policies`
  row cap 2 → three inserts, exactly two commit; Monday override 1 → second refused.
  Mutants `MUT-COUNT-SELF` (exclude by id), `MUT-CAP-IGNORE-DOW`.

**Proof of done:** demo DB migrated clean; `test-tool-bookAppointment.js` suite still
green on real Postgres; a hand query shows two same-patient future bookings coexisting.

---

## Phase 1 — Skin Essence go-live minimum

Each item: change → test → proof. All must land before cutover; none needs capacity>1.

**1.1 Gujarati greeting + recording notice.**
`GREETING_TEXTS['gu-IN']` and `RETURNING_GREETING_TEXTS['gu-IN']` (callHandler.js:955/960),
recording line INSIDE the greeting string (one string, one TTS call, one cached buffer):

> નમસ્તે! હું ઋતુ બોલું છું, સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટરમાંથી. આ કૉલ રેકોર્ડ થાય છે. બોલો, હું આપની કેવી રીતે મદદ કરી શકું?
> (returning) નમસ્તે {name} જી! હું ઋતુ, સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટરમાંથી. આ કૉલ રેકોર્ડ થાય છે. બોલો, આજે હું આપની કેવી રીતે મદદ કરું?

**REVIEW FIX (blocking #3):** `preloadGreeting()` currently runs at require time —
before any DB/resolver could exist. Make `GREETING_TEXT` computed inside
`preloadGreeting()` (not a module const) and move the invocation into index.js's boot
sequence after DB init. This is also the hook Phase 2's `clinic_strings` resolver
needs; doing it now costs nothing extra.
Extend `isRecordingAnnouncement` (callHandler.js:566–568) with Gujarati tokens
(`રેકોર્ડ|રિકોર્ડ`, `કૉલ|કોલ|થાય છે|થઈ રહ્યો`) and add `શું` to the question exemption — a
caller ASKING "શું આ કૉલ રેકોર્ડ થાય છે?" must reach the model, our echo must not.
*Test:* drive `isRecordingAnnouncement` both ways (the exact notice → true; the
question → false); greeting build under `GREETING_LANG=gu-IN` produces gu text (mutant:
remove the gu entry → the existing "no greeting template" warn fires → red).
*Proof:* boot line `✓ Greeting audio pre-cached (gu-IN, voice=ritu, …)`; a native
speaker signs off call 1's audio.

**1.2 Price disclosure.** `getTreatments` SELECT adds `disclose_price`; `_price(t)`
first branch: `if (t.disclose_price === false) return 'price: doctor dekh kar
batayenge';` — numbers fetched for the desk, **never concatenated into text**. Prompt:
REPLACE (not append) the phrase-specific sentence at brain-lean.js:570 with the generic
"Price mein number NA likha ho toh jo likha hai HUBAHU wahi bol — apna koi number KABHI
mat laga." (defect-class-6: the old sentence names one rendering and would contradict
the new one).
*Test:* render with a disclose=false row → text contains no digit from price_min/max;
flip → digits appear. Mutant `MUT-DISCLOSE-ALL`.
*Proof:* R7 call 4 — Hydrafacial ₹3000 spoken, wart price refused.

**1.3 Holidays reach the offer side** *(hard date: Raksha Bandhan is 28 Aug).*
`doctor_exceptions` is consulted by the ACCEPT side only (availability.js/findDoctor.js);
brain-lean's `firstFreeSlot`/`liveAvailability` never read it — the exact ae16022 split;
on 28 Aug Ritu would offer 11:00 and the commit would refuse it.
Fix in the offerWindow discipline: `db.getUpcomingExceptions(clinicId, horizonDays)` →
loaded and refreshed **inside `refreshTakenSlots`'s existing TTL cycle** (holidays are
added intraday; boot-bake is defect class 3) → `firstFreeSlot` skips a `(doctor, ymd)`
with a `closed`/`leave` exception; `doctorLine`'s KAL/BAND line renders the exception
date as BAND.
*Test:* fixture with a 'closed' exception two days out → `firstFreeSlot` never returns
that ymd; the walk-every-minute parity check extended with exceptions. Mutant
`MUT-OFFER-IGNORES-EXCEPTIONS` → red.
*Proof:* R7 call 9 — 28 Aug is never offered, alternative books cleanly.

**1.4 Cancel/reschedule OFF** (preset booleans consumed at three layers — a prompt
line alone is defect class 6):
1. prompt: rules 7(b)/8 and both sentinel definitions NOT emitted (the model can't be
   right-either-way about instructions it never saw); replacement rule: cancel request
   → name → `REQUEST_CALLBACK` → speak `cancelPolicy` line;
2. sentinel handlers (brain-lean.js:1386/:1495): suppress, speak `cancelPolicy`, log
   `[POLICY] cancel/reschedule sentinel suppressed`;
3. `tools/updateAppointment.js`: `context.policy.agentMayCancel === false` →
   `{success:false, fail_kind:'staff_only'}`.
Config: `presets/aesthetic.js` exports `{ agentMayCancel:false, agentMayReschedule:false,
VERSION }`; selected by `clinics.clinic_type` (add the column now:
`ALTER TABLE clinics ADD COLUMN clinic_type TEXT NOT NULL DEFAULT 'gp' CHECK (clinic_type
IN ('gp','aesthetic','dental','multispecialty','single_specialty'))` — ride migration 013).
`cancelPolicy` canned line, gu primary: "માફ કરશો, cancel કે reschedule ફક્ત ક્લિનિક સ્ટાફ જ
કરી શકે છે — હું તમારી request નોંધી લઉં છું, ક્લિનિક તમને સામેથી કૉલ કરશે. મહેરબાની કરીને ઓછામાં
ઓછા 2 કલાક પહેલાં જાણ કરી દેજો." (+hi/en). The "2 hours" is content in the string; nothing
enforces it and nothing pretends to.
*Test:* drive a turn whose model output contains `CANCEL_APPOINTMENT:{...}` with the
preset off → no tool call, canned line spoken, log line present. Mutant
`MUT-CANCEL-OBEYED` → red. *Proof:* R7 call 8.

**1.5 Derm advice-guard pack + intake decoupling** (live bugs c and d):
- `medicalAdviceGuard.js`: add the derm/aesthetic pattern pack — cream/क्रीम/ક્રીમ,
  serum, lagau/લગાવું, "mere liye theek/ચાલશે", laser+skin suitability shapes, gu
  question forms. *Test:* the two measured misses ("કઈ ક્રીમ લગાવું", "meri skin pe laser
  chalega kya") now return the deflection; existing GP cases untouched.
- Intake trigger: at an aesthetic clinic (preset), the history machine starts for ANY
  booking intent, not only on a symptom-lexicon hit (callHandler.js:3739's
  `specialtiesForSymptom(probe).length === 0 → return null` gains
  `|| PRESET.intakeOnBooking` handling). Slots for aesthetic: `area`,
  `prior_treatment`, `allergy` (wording gu/hi/en per the manifest §1.8; code tables
  now, clinic_strings later). Split the bundled meds+allergy question — two slots, two
  strings. *Test:* drive "hydrafacial book karna hai" → intake asks area →
  prior_treatment → allergy before the offer; drive the GP fixture → unchanged.
  Mutant `MUT-INTAKE-SYMPTOM-ONLY` → red.
*Proof:* R7 calls 1 and 5.

**1.6 Booking rules, launch subset.** `SLOT_SEARCH_DAYS` (brain-lean.js:230, const 8)
becomes env-readable `SLOT_SEARCH_DAYS` — Skin Essence sets 2 (D13a). `SLOT_LEAD_MINUTES`
already =30 offer-side; keep. `bookAppointment` snaps to grid via `snapToGrid` (0.3).
Everything else (accept-side horizon/notice/cutoff, capacity>1, GAYA counts) is Phase 2.

**1.7 FEES line + default doctor** (review: doctors.notes is never rendered — putting
policy there does nothing). `buildSystemPrompt` gains one code-built line from
`clinic_policies`: "FEES: consultation ₹700. Follow-up: pichhli visit ke 5 din tak FREE,
uske baad ₹400." and "Caller doctor na bole → Dr. Daksha Patel book kar." from
`default_doctor_id`. The per-caller resolved follow-up line ("IS caller ki pichhli
visit …") stays OFF until the attendance writer ships — `status='completed'` is
polluted by the no-show bug and a `no_show` row must never earn a free follow-up.
*Test:* prompt contains both lines when the policy row exists, neither when absent
(deletion test). *Proof:* R7 call 10's fee answer.

**1.8 FAQ block** (D7 — one row: parking). `db.getClinicFaqs` clones the getTreatments
shape (code-built text, fail-open); loaded in `preloadRoster`; refreshed with the same
TTL cycle as 1.3 (review: the one clinic-edited table must not be boot-frozen). Prompt
block after TREATMENTS, same conditional shape — absent when empty, byte-identical GP
prompt (assert it). The block's fallback sentence excludes ADDRESS/DOCTORS/TREATMENTS
so it can never override their stronger rules.
*Test:* FAQ-shaped turn serves the verbatim string; empty table → prompt byte-identical.
Mutants `MUT-FAQ-FREESTYLE`, `MUT-FAQ-ZERO-AT-BOOT`.

**1.9 Reminder: 2 hours, correct word, correct language** (live bugs f/g):
- `getAppointmentsForReminder` (db.js:197) parameterised:
  `BETWEEN NOW() + make_interval(mins => $2 - 10) AND NOW() + make_interval(mins => $2 + 10)`
  under a `*/10` cron; offset from `clinic_policies.reminder_offset_minutes`.
- Same-day copy: the "kal/આવતીકાલે" vs "aaj/આજે" word chosen by comparing the
  appointment's IST date to today's — on BOTH the template path and the text path.
- **The language bug:** `sendTemplateOrText` passes `language: undefined` → every
  template send falls to `META_TEMPLATE_LANGUAGE` (default hi). Thread the
  conversation/clinic language through ALL its callers (confirmation, reminder,
  followup, missed-call, no-show) — and set `META_TEMPLATE_LANGUAGE=gu` on this silo as
  belt-and-braces.
- `runReminderJob` stamps `reminder_sent_at = NOW()` in the same UPDATE as
  `reminder_sent = TRUE` (needs the column — ride migration 013:
  `ALTER TABLE appointments ADD COLUMN reminder_sent_at TIMESTAMPTZ;`). The timestamp
  is how "the 24h shape silently survived" stays detectable.
- A booking made INSIDE the window gets no reminder, by design (the confirmation just
  went out) — comment + test case, not silence.
*Tests:* `test-reminder-2h-driven.js` (drive the exported job; assert window params
120±10, the `reminder_sent_at` stamp, the skip case). Mutants `MUT-REMINDER-24H`,
`MUT-LANG-UNDEFINED`. *Proof:* cutover gate 6 — staged appointment 2h out gets the gu
"આજે" reminder; nothing at 24h.

**1.10 Config snapshot, minimal.** `calls.config_snapshot JSONB` (ride 013) written by
one resolver: `{ clinic_type, preset:{name,version}, policy:{version,updated_at}|null,
runtime: runtimeConfig(), snapshot_at }` — assembled fresh per call (TTL-cached reads),
`null` meaning "no row governed" (never `{version:0}`). *Test:*
`test-config-snapshot-driven.js` incl. the serve-a-row-mid-test freshness case.
Mutants `MUT-SNAPSHOT-DROPPED`, `MUT-SNAPSHOT-BOOT-FROZEN`.

---

## Phase 2 — post-go-live (order within phase by value)

1. **Capacity 2/slot + Monday 1 + daily cap 25 live** — getTakenSlots → count Map;
   firstFreeSlot `slotFull`/`dayFull`; GAYA renders only at-capacity slots; per-day
   counts floor at start-of-today IST, not NOW() (review: elapsed slots must count
   toward the daily cap). The anti-ae16022 **parity test**: every offerable minute
   under every policy fed to the accept chain; mutation both ways per rule.
2. **Accept-side horizon / notice / cutoff** in availability.js with `fail_kind`s
   `beyond_horizon`, `too_soon`, `same_day_closed` + canned lines (closes D13).
3. **`clinic_strings` table + resolver + desk editing** (DB→preset→code chain; the
   greeting hook from 1.1 is already in place; TTL re-synthesis of greeting audio;
   desk-form validations: money/time-range/medicine-name/single-script per lane spec).
4. **Attendance writer on the desk** → first production caller of
   `markAppointmentConfirmed` → flip `NOSHOW_JOB=on` in the same deploy.
5. **Derm emergency lexicon** (D1): chemical-in-eye, post-procedure swelling, filler
   vascular occlusion (~90-min window), post-laser blistering — clinically sourced,
   code-owned, Dr. Patel reviews. Until then v1+v2 GP coverage stands.
6. **Proof layer full**: `proofManifest.js` + `tools/check-proof-manifest.js` +
   `tools/run-mutants.js` as gate steps; `job_heartbeats` table + per-job heartbeats
   (migration 014).
7. Pronunciation hints (`tts.<lang>.<form>`, applied only at the TTS boundary) — ships
   empty; the ten test calls say whether it's needed.

## Not building (explicit)

- A config language / per-clinic flow editor / per-clinic emergency checkboxes
  (prior do-not-build list stands).
- Variable-length bookings from `treatments.duration_min` (desk info only; wart books
  a standard slot).
- A same-call correction flag (D6).
- Multi-clinic anything. Silo stands.
- `no_show_recovery` Meta template — not even submitted until the attendance writer
  ships (a template that cannot fire cannot mis-fire).

## Seed + env + cutover (execute as written)

Seed `db/seed-skin-essence.js` (fixed UUID, idempotent): 1 clinic row
(type=aesthetic, tz Asia/Kolkata), 2 doctors (`slot_minutes=10`, fee 700), 24
schedule rows (D2), 5 treatments (peel 1500/T, hydrafacial 3000/T, wart 1500–5000/F,
tattoo 1500–3000/F, cryolipolysis 3500/T), 1 FAQ (parking, gu+en), 6
doctor_exceptions ('closed': 28 Aug, 4 Sep, 20 Oct × 2 doctors), 1 clinic_policies row
(horizon 2, notice 30, cutoff 60, capacity 2, `{"1":1}`, daily 25, gap 10, slot 15,
default_doctor=Daksha, followup 5/400, reminder 120, version 1).

Env (voice): `CLINIC_MODE=lean`, `CLINIC_ID_UUID=<seed>`, `GREETING_LANG=gu-IN`,
`CLINIC_GREETING_NAME=સ્કિન એસેન્સ કોસ્મેટિક એન્ડ લેસર સેન્ટર`, `CLINIC_NAME=Skin Essence
Cosmetic and Laser Center`, `CLINIC_ADDRESS=<Q3 text>`, `APPOINTMENT_SLOT_MINUTES=10`,
`SLOT_SEARCH_DAYS=2`, `STT_MODE=codemix`, `ENABLE_MULTILINGUAL=true`,
`ENABLE_ROSTER_SLICE=true`, garble/prewarm/speculation flags copied from the demo's
proven set, `EMERGENCY_V2_ENFORCE=selfharm,stroke,poisoning`, `MEDIA_STREAM_SECRET=<new>`,
`GOOGLE_SHEET_ID` unset, **no `CALENDAR_ID` and no `GOOGLE_SERVICE_ACCOUNT_JSON`** (founder decision 2026-09-08: the desk is the calendar; the boot requires Google credentials only when `ENABLE_GOOGLE_CALENDAR=true` or a Sheet is set), `META_TEMPLATE_LANGUAGE=gu`, WhatsApp trio,
`REMINDER_JOB=on` (others unset), `ENABLE_PREVISIT_INTAKE=off` (founder decision 2026-09-04: booking only — no duration/medicines questions on voice or WhatsApp), `ENABLE_REPORT_INTAKE` unset, `EXOTEL_PHONE_NUMBER=<DID>`. The test suite runs under this exact switch set as the `skin-essence` profile of `tests/_bootstrap.js` on every push. Boot line must show
none of the ⚠ USING DEFAULTS warnings.

Runbook + ten Gujarati test calls + cutover gate: as the manifest lane wrote them
(R1–R8, calls 1–10, gates 1–11) with two amendments — gate 9 reads per **D12**, and
call 4's leak check is at render level (the suppressed treatment's prompt line contains
no digits), not a bare-number grep, because ₹1500 legitimately appears on the peel.
Cutover = dialing `**61*<DID>**25#` from the clinic's Airtel SIM, only after all 11
gates pass.

## Setup-call questions (proceed on defaults if unanswered)

1. 10-min doctor slots vs 15-min form default → **default: 10** (both doctor rows say
   it; `slot_minutes=10` seeded; pitch 20 with the gap).
2. "Existing software" (Q55/Q69, named nowhere) → **decided 2026-09-08: our desk only.** No
   Google Calendar mirror; nothing is shared to info@skinessence2017.com.
3. Canonical Latin name spelling (D12) → default as seeded.
4. Recording retention (Q74 blank) → **default 90 days** on the Exotel store.
5. Horizon inclusivity ("2 days" = today+kal+parso?) → **default: dayOffset ≤ 2.**
6. Daily cap 25 — hard refusal or soft target → **default: hard** (trigger refuses).
7. Window end semantics (20:00 = last offerable start, per offerWindow) → default as
   seeded; flip end_time to 19:50 if the clinic means "doors shut at 8".

## Weekly queries (Monday, per clinic)

```sql
-- 1. No-show integrity (must be 0 until the attendance writer ships)
SELECT count(*) FROM appointments WHERE status='no_show' AND updated_at > now()-interval '7 days';
-- 2. Bookings that bypassed policy (must be 0 after Phase 0)
SELECT id FROM appointments WHERE status='booked' AND created_at > now()-interval '7 days'
  AND booking_evidence IS NULL;
-- 3. Price-silence audit (soft): wart/tattoo/મસા near a ₹-figure in Ritu's turns
SELECT exotel_call_sid FROM calls WHERE created_at > now()-interval '7 days'
  AND transcript::text ~ '(wart|tattoo|મસા|મસો)' AND transcript::text ~ '₹\s*\d{3,}';
```
