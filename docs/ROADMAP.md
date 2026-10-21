# Roadmap — why Ritu misbehaves, and the order to fix it

Written 2026-08-14, after a Bengali call was reported as "not working properly".
Everything below is measured on production data. Where a number is an estimate
it says so.

The honest starting point: the work up to this date has been **reactive**. A call
surfaced a defect, the defect got fixed, the next call surfaced another. That is
patching, and it does not predict the next failure. This document exists to stop
that, and it is built research-first for the same reason.

---

## 1. The root cause

**Patient identity is keyed on a transcribed name, and transcribed names are not
stable.**

`patients` is `UNIQUE (clinic_id, phone, name)`. Every time the STT renders the
caller's name differently, a new human is created.

MEASURED, 2026-08-14, across all patient rows:

| | |
|---|---|
| handsets carrying more than one patient row | **10 of 28** |
| rows minted <10 min apart on one handset (one human, one call) | **16** |
| placeholder strings that became patients | **15** — `"Unknown"`, `"your name"`, `"ಅಪರಿಚಿತ"`, `"."`, `"[Patient Name]"` |
| worst single human | **8 rows** — `Pruthvi / gawda / ಅಪರಿಚಿತ / ಅಪರಿಚಿತ / Unknown / Prithvi / Prithvi / .` |

### How that becomes "she is not behaving right"

Call `5b261b844e65a68bbe1aeb5512a11a8e`, Bengali, 2026-08-14. One caller, one
handset, **three patient rows in 2 minutes 19 seconds**:

```
07:58:15  3402e8d6  "Aman Nambaria"
07:59:00  6d7fdcba  "আমন নাম্বারিয়া"     <- the same name, Bengali script
08:00:34  be74f240  "[Patient Name]"    <- a literal prompt placeholder
```

The appointment was committed against `3402e8d6`. When the caller then said
"অ্যাপয়েন্টমেন্টটা নিশ্চিত করুন" (*confirm the appointment*):

1. the model re-emitted `BOOK_APPOINTMENT` — correct, the caller asked
2. `bookAppointment` looked for an existing row by **patient_id**, which had
   drifted to a different row → the idempotency check missed
3. the INSERT hit `uniq_doctor_slot (doctor_id, appointment_time)` — the slot was
   taken **by the caller himself**
4. the tool returned `success: false`
5. `brain-lean.js:889` spoke `cannedLine('slotNoAlt')` —
   **"ওই সময়ে পাওয়া যাবে না"** — *that time is not available*

The roster says Dr. Alka Ranade works 17:00–20:00 that weekday. Nothing
hallucinated. **Our own code told the caller a true thing about the database and
a false thing about the world.**

### The same root cause, already seen four times

| symptom | fixed in | what it really was |
|---|---|---|
| household medication prior | `79f2677` | one phone, several patient rows |
| wrong-name greeting | `21e6cc1` | newest row wins, and rows splinter |
| cancel ambiguity | `556b9b4` | cannot tell which row the caller is |
| **false "not available"** | **open** | idempotency keys on a drifted patient_id |

Four "separate" bugs, one cause. That is why it felt like patchwork — it *was*
patchwork, applied to instances of a class nobody had named.

### What it is NOT

An earlier reading of these calls blamed the LLM for inventing an availability
verdict. **That was wrong.** `brain-lean.js:541/549` are canned lines in our own
code, and `{alt}` is a slot our own formatter produced. The model is not the
defect here; it is the messenger.

### CORRECTION, after adversarial verification

The first census said 16 contradictions in 184 assertions. An independent
re-derivation **disagreed**: **18 in 196, across 17 calls**, plus 8 more of a
class the first pass under-counted — **26 false-as-spoken availability claims
across 22 calls, roughly 1 in 7.4 substantive calls.** The direction survived;
the number did not. Quote the second one.

And identity drift — the fix in `f972115` — explains only *some* of them. The
verified sample contains at least four distinct causes:

| cause | evidence |
|---|---|
| **roster slice** | call `0a0f0d8f`: caller asks "कोई अभी doctor available है" while **nine doctors were mid-session**; `diagnostics.rosterSlice` shows **2 of 25** doctors were in the prompt. The model cannot speak about doctors it was never given. |
| **identity drift** | call `5b261b844e`, above — fixed in `f972115` |
| **fabricated windows** | call `598b0e63`: "सुबह 10 से 1 और शाम 4 से 6" for a doctor whose only window is 18:30–20:30. The caller worked it out: *"तो क्या आपने मेरे से झूठ बोला था?"* |
| **no slot-capacity model** | call `56d6db79`: "सुबह के सभी स्लॉट्स भर चुके हैं" when `appointments` held **zero rows** for that morning |

Three calls also offered **Sunday**, when nobody at Smile Dental has a Sunday
schedule. In `fc3ba30a` the patient, not the system, caught it.

**So `rosterSlice` is the larger lever, not identity.** It was measured ON in
production (`[LEAN] Roster slice: … 2/25 doctors in detail`). Narrowing the
prompt saves tokens and latency; it also makes "who is free right now"
unanswerable, and the canned lines then report that as unavailability.

Measured for completeness — the model's factual accuracy is otherwise *good*:

| fact class | contradictions / assertions |
|---|---|
| specialty | 0 / 66 |
| fees | 2 / 37 |
| doctor existence | 1 / 119 |
| availability | 16 / 184 — **and these trace to the code path above** |

---

## 2. The second root cause

**The tests do not gate the deploy.**

- `npm test` is `echo "Error: no test specified" && exit 1`
- `.git/hooks/pre-push` contains **zero** references to `tests/`
- 65 test files, many mutation-proven this week, run only when someone loops the
  directory by hand

The gate does run four real things — migration safety, the ritu-evals immune
suite (28 metrics), boot-smoke, vendor-claim checks — but **nothing that
exercises the call path**. A regression in any call-path test pushes green.

That is the mechanism by which defects keep reaching production: nothing
systematically stops them, so every one has to be found by a human placing a
call.

---

## 3. The workflow, for every change from here

This is the part that replaces "notice → patch".

**RESEARCH** — before designing, measure the class on production data. How often,
which calls, what is the harm. A fix whose prevalence is unknown is a guess.
Write the number down.

**VERIFY** — reproduce it deterministically. Independently re-derive the number
(the count above survived an adversarial re-derivation; the first acoustic metric
did not). If it cannot be reproduced on demand, it cannot be fixed on purpose.

**TEST** — drive the code, never assert on its source text. Mutation-prove in
both directions: the new test must go red when the bug is reintroduced, and the
old behaviour must stay green. Reference shape: `tests/test-phone-identity.js`,
`tests/test-emergency-v2-enforcement.js`.

**DEPLOY** — through a gate that actually runs what you wrote.

---

## 4. The order

### P0 — one patient is one row — **DONE, `f972115`**
Real, and real but partial. Everything downstream of `patient_id` inherits it.

- resolve identity by **phone first**, name second; a new name on a known handset
  updates that row rather than minting one
- never write a placeholder as a patient (`[Patient Name]` reached the table)
- cross-script equivalence: `Siddharth` ≡ `सिद्धार्थ` ≡ `আমন` for the same handset
- backfill: merge the 16 same-call splinters, repoint their children
- **gate**: a call that hears the name three ways creates exactly one row

### P0.5 — the roster slice hides most of the clinic
Larger than identity, and unfixed. `ENABLE_ROSTER_SLICE` narrows the prompt to
specialty-matching doctors; on a "who is free now" question that left **2 of 25**
in context while nine were seeing patients.

- a whole-clinic availability question must not be answered from a slice
- "is anyone free now / today / tomorrow" needs a roster query, not a prompt
- **gate**: a call asking "कोई अभी available है?" names a doctor who is
  genuinely mid-session, on a fixture where nine are

### P1 — a booking failure must not be spoken as unavailability
The symptom the caller actually hears. Independent of P0 and much smaller.

- `bookAppointment` must distinguish *slot genuinely taken by someone else* from
  *this caller already holds it* — the second is `idempotent: true`, not a failure
- `slotNoAlt` is only correct for the first case
- **gate**: re-confirming your own appointment returns success, never
  "that time is not available"

### P2 — make the tests gate
Without this, P0 and P1 decay.

- `npm test` runs `tests/*.js`
- the pre-push hook runs it before the eval suite
- **gate**: a deliberately broken test blocks a push

### P3 — facts with no source
9 of the 24 facts the prompt invites Ritu to state have **no authoritative
column**. The clinic address is the visible one (asked in 3 calls; `clinics` has
no address column at all — she deflected 4 times in one call).

- add the columns, or instruct the model never to offer the fact
- **gate**: every fact in the prompt maps to a column or an explicit refusal

### P4 — slot capacity
`uniq_doctor_slot` is `(doctor_id, appointment_time)` UNIQUE. Indian OPD runs
**windows with queues**, not exclusive slots. Today the second caller wanting
17:00 is refused — correct per the schema, wrong per the clinic.

Deferred deliberately: P0 and P1 must land first, because they currently
*masquerade* as capacity problems.

---

## 5. Known-bad, do not trust

- **`diagnostics.audio`** (shipped `95f5c0a`) is wrong on real calls. First live
  reading: `floorP50 8, floorP90 3571`. A background floor whose p90 is 3571 is
  not background — VAD lag lets speech into the floor bucket. It passed on
  synthetic fixtures. Fix the sampler before quoting any SNR.
- **3 test rewrites were rejected at review** (truncated / never written to
  disk): `test-llm-providers`, `test-runtime-config`, `test-tool-calling-loop`.
  Still vacuous.
- **`appointments.confirmed`** can only ever be `FALSE`; nothing sets it and the
  no-show job keys on it. Every appointment above reads `no_show`.
