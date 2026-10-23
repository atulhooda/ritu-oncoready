# RITU AI Clinical Records Assistant

A doctor-only chat and voice panel (bottom right of the doctor dashboard) that answers questions
about the patient on screen from that patient's records, with a source for every statement.
Rules: `BEHAVIOR_SPEC.md` → "Records assistant". Synthetic data only.

## How an answer is made

```
question ──► POST /doctor/patients/{case_id}/assistant   (doctor, same org, sent profile; else 404)
              │
              ├─ build_corpus(case)          app/assistant/corpus.py — this case only
              │    record facts · every OCR page line · pending tests · patient-reported facts
              │    measurements (value + unit + date) read in code from record text
              │
              ├─ "pending / outstanding"  ──► pending tests, in code
              ├─ names a measurement      ──► measurements, in code: nearest date, previous vs
              │                                latest, differences (same units only)
              └─ anything else            ──► local keyword retrieval (≤ 40 items) ──► LLM returns
                                               item ids + quotes ──► each quote verified against
                                               its item ──► answer built in code from the whole
                                               source sentences; conflicts flagged
```

The LLM never writes answer text. Record text is treated as data; text addressed to an AI is
flagged, not followed.

## Run it locally

```bash
docker compose up -d                                    # stack (backend runs migrations)
backend/.venv/bin/python seed/render.py                 # renders seed/personas/records/*.pdf
docker compose exec backend python /seed/seed.py --intake   # adds Maria's two clinic notes, runs OCR + extraction
```

Sign in as `doctor@demo.example.com` / `synthetic-demo-pass`, open **Maria Placeholder**, and use
**Chat** or the microphone at the bottom right. Open questions need `GEMINI_API_KEY` (or
`GROQ_API_KEY`); without one they fall back to labelled keyword matches. Measurement and
pending-test questions need no LLM.

## Demo (Maria's synthetic records)

| Case | Ask | What happens |
|---|---|---|
| 1. Historical measurement | "What was the pulse rate three months ago compared with the latest?" | 80 bpm (20 July 2026, July clinic note) and 115 bpm (15 October 2026, October note); "increased by 35 bpm"; both sources |
| 2. Conflict | "Does the patient have any allergies?" | "No known drug allergies" (July) and "penicillin (rash)" (October) both shown with a conflict note, plus the patient's own statement to Ritu, labelled patient-reported |
| 3. Missing | "When was the last PET-CT scan performed?" | "I couldn't find this in the available records." |
| 4. Voice | Microphone → ask case 1 aloud | Transcript shown, same answer, read aloud |

More: "Compare the previous and latest hemoglobin" (11.8 → 10.2 g/dL, dates written with each
value), "Has the recorded weight changed?", "What was the pulse rate yesterday?" (missing, nearest
given), "What medications were recorded during the last visit?", "Which investigations are still
pending?", "What symptoms did the patient report recently?".

## Limitations

- **Voice** uses the browser: Chrome / Edge speech recognition sends audio to the browser vendor's
  service (not offline); Firefox has none. Speech output uses the device's voices. The voice path
  was tested with a stand-in recogniser (headless Chrome has no speech service), not a real mic.
- **Highlighting**: OCR word positions are not stored, so a source opens at the right page with the
  passage shown above it, not drawn on the image.
- **Measurements** cover pulse, BP, temperature, weight, hemoglobin, SpO2 and LVEF. Other lab values
  are found through open questions (shown as quotes, not compared numerically).
- **Retrieval** is keyword-based (with a few synonyms), fine for one patient's records; a question
  worded very differently from the record may miss.
- **Open-question quality** depends on the LLM's selection; what it selects is always verified and
  shown with its source, but it can miss a relevant item.
- **Follow-ups**: each question is answered on its own ("and the one before that?" has no context).
