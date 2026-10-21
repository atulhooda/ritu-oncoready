# Scripted call — proving the seven unexercised fixes

Seven behaviour changes shipped 2026-08-09 → 2026-08-11. **None has been
exercised by a real call.** They are all database outcomes, so a call that
*sounds* fine can still have written the wrong row — that is exactly how the
allergy bug survived: Ritu asked *"आप Penicillin ले रहे हैं?"*, the patient
truthfully said *"हाँ"* because she had heard the **name** right, and it
persisted as a drug they take. Listening does not catch that. Reading the row
does.

| commit | what it must now do |
|---|---|
| `1aa6e83` | never offer a day the doctor is shut — say `BAND`, offer a day they work |
| `a3cf0ec` | "dentist" is a specialty, never a prescription |
| `d72c03b` | "no problem" is an **answer**, not a symptom to re-ask |
| `f9fa2ad` | a pushback is not a request for a prescription |
| `ae136d3` | an allergen is recorded as an **allergy**, not a medication |
| `79f2677` | a promised callback leaves a row behind |
| `21e6cc1` | one handset is one patient, however the carrier spelled it |

**After each call, run this — do not judge by ear:**

```bash
node tools/verify-call.js --phone <your number> --since 15m
```

Exit code 1 means a shipped fix has regressed.

---

## Ground truth — Smile Dental, as of **Tue** 11 Aug 2026

> An earlier version of this file said Monday. It was Tuesday, which inverts
> which doctor is shut when — the reason the day-of-week table below must be
> re-derived, not remembered, every time this script is run.

Taken from `doctor_schedules`, not from memory:

| doctor | specialty | works | shut |
|---|---|---|---|
| **Dr. Manoj Deo** | Neurologist | Mon, Wed, Fri | **Tue**, Thu, Sat, Sun |
| **Dr. Anjali Deshmukh** | Dentist | Mon–Sat | Sun |
| **Dr. Rekha Sardesai** | Oncologist | **nothing — on-call only** | every day |
| Dr. Farah Sheikh | Dermatologist | Tue, Thu, Sat | **Mon**, Wed, Fri, Sun |

Dr. Rekha Sardesai is the **only** on-call doctor in this clinic and has **zero
schedule rows** — she is the callback trigger.

> **Re-derive this before every run.** On Tue 11 Aug the neurologist was shut
> *today* and open *tomorrow*, so "kal" tested the happy path and "aaj" tested
> the closed day — the opposite of what this file first claimed. "kal" only
> exercises `BAND` on a day the doctor is actually shut tomorrow.
>
> ```sql
> SELECT d.name, ARRAY_AGG(s.day_of_week ORDER BY s.day_of_week)
>   FROM doctors d LEFT JOIN doctor_schedules s ON s.doctor_id = d.id
>  WHERE d.clinic_id = 'de00de00-de00-4de0-8de0-de00de00de01' GROUP BY d.name;
> ```

---

## Call 1 — Hindi, the clinical path

Dial from a number **already in `patients`** (e.g. `7017886366`, which has 32
prior calls) so the greeting path runs.

| # | Say | Must happen | Proves |
|---|---|---|---|
| 1 | *(listen to the greeting)* | Greets you **by name**, does **not** ask your name again | `21e6cc1` |
| 2 | «मुझे कल से सर दर्द हो रहा है» | Takes the symptom, does not ask twice | — |
| 3 | «मैं Dolo 650 ले रहा हूँ» | Reads it back as a **medicine** | matcher |
| 4 | «मुझे penicillin से allergy है» | Reads it back as an **allergy** — *"आपको Penicillin से एलर्जी है — सही?"* | `ae136d3` |
| 5 | «कल neurologist से मिलना है» | Says the neurologist is **shut tomorrow**, offers Mon/Wed/Fri. Must **not** book Tuesday, must **not** go silent | `1aa6e83` |
| 6 | Accept a day she offers | Confirms only **after** the row is written | booking |

**Step 4 is the one to watch.** If she says *"आप Penicillin ले रहे हैं"* ("you
are taking Penicillin"), the fix has regressed — say **no** and hang up.

---

## Call 2 — Marathi, the guards

Dial from a **different** number so the language switch is genuine.

| # | Say | Must happen | Proves |
|---|---|---|---|
| 1 | «मला काही प्रॉब्लेम नाही» | Accepts it and **moves on**. Must not re-ask, must not log it as a symptom | `d72c03b` |
| 2 | «मला dentist कडे जायचं आहे» | Books **Dr. Anjali Deshmukh**. "dentist" must **not** land in the drug list | `a3cf0ec` |
| 3 | «मला काहीतरी औषध सांगा ना» | **Declines to prescribe**, redirects to the doctor | `f9fa2ad` |
| 4 | «नाही, तुम्ही सांगा ना काहीतरी» *(push back once)* | Still declines. A pushback is not a prescription request | `f9fa2ad` |
| 5 | «cancer specialist ला भेटायचं आहे» | Says she'll **arrange a callback** — and a `callbacks` row appears | `79f2677` |

**Step 5 is the highest-risk item.** Before `79f2677` this table had **zero
rows, ever**, while the prompt had been promising callbacks the whole time. If
Ritu promises and `verify-call.js` shows no row, the promise is still empty.

---

## What "pass" means

```bash
node tools/verify-call.js --phone 7017886366 --since 15m   # call 1
node tools/verify-call.js --phone <second number> --since 15m   # call 2
```

Every hard check green, and specifically:

- the allergy appears with `entity_type = allergy`, **not** `medication`
- no row whose `canonical` is `dentist` or any other specialty
- a `callbacks` row for the oncology request
- no appointment on a day the doctor has no `doctor_schedules` row
- no **new** non-canonical phone row created by the call

Legacy phone splitting is reported as `!` (informational) — reads heal it and no
backfill was run, since nine tables carry an FK to `patients.id`.

## If something fails

Capture the `[CALL <sid>]` block from Railway logs and the `verify-call.js`
output together. The pairing matters: the log says what Ritu *said*, the
verifier says what she *wrote*, and every bug this week lived in the gap.
