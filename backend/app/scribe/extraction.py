"""Consultation transcript -> prescription draft. The LLM *extracts* what the doctor said (medicines
with dose / frequency / duration, tests ordered, advice, follow-up, the doctor's stated assessment),
each with the turn it was said in and a quote. Code keeps an item only if the quote is found in that
turn (rapidfuzz >= span_match_threshold) and stores the aligned turn text. Nothing is suggested or
added: an item with no verified quote is rejected and kept for audit. The doctor then edits and
approves the report; nothing reaches the patient before that."""

import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.llm import client as llm
from app.pipeline.extraction import align_span
from app.repositories.consultations import ConsultationRepository

SECTIONS = ("assessment", "medicines", "tests", "advice", "follow_up")
MEDICINE_FIELDS = ("name", "dose", "route", "frequency", "duration", "instructions")


class Evidence(BaseModel):
    model_config = ConfigDict(extra="ignore")

    turn_index: int = Field(ge=0)
    quote: str = Field(min_length=2, max_length=1000)


class MedicineCandidate(Evidence):
    name: str = Field(min_length=1, max_length=120)
    dose: str | None = Field(None, max_length=80)
    route: str | None = Field(None, max_length=40)
    frequency: str | None = Field(None, max_length=80)
    duration: str | None = Field(None, max_length=80)
    instructions: str | None = Field(None, max_length=300)


class TextCandidate(Evidence):
    text: str = Field(min_length=1, max_length=500)


class LlmPrescription(BaseModel):
    """Envelope only; items are validated one by one so one bad item doesn't sink the rest."""

    doctor_speaker: int | None = None
    assessment: list[dict[str, Any]] = Field(default_factory=list)
    medicines: list[dict[str, Any]] = Field(default_factory=list)
    tests: list[dict[str, Any]] = Field(default_factory=list)
    advice: list[dict[str, Any]] = Field(default_factory=list)
    follow_up: list[dict[str, Any]] = Field(default_factory=list)


INSTRUCTIONS = """Below is the transcript of a consultation between a doctor and a patient (Hindi,
English or mixed), as numbered turns "[n] SPEAKER k: text". Extract ONLY what the DOCTOR said
they are prescribing, ordering or advising. Do not add, suggest, correct or complete anything,
and do not use medical knowledge to fill gaps: if the doctor did not say a dose, leave it null.
- doctor_speaker: the speaker number k of the doctor (the one who asks, examines, prescribes), or null
- medicines: one per medicine the doctor prescribed or told the patient to continue / stop / hold:
  {name, dose, route, frequency, duration, instructions, turn_index, quote}. name and the other
  fields in short English (translate if needed, e.g. "twice a day", "5 days", "after food").
  frequency is only how often; timing like "empty stomach" goes in instructions. If the doctor
  said to stop or hold a medicine, instructions starts with "Stop" or "Hold"; to keep taking it,
  "Continue".
- tests: tests, scans or referrals the doctor ordered: {text, turn_index, quote}
- advice: other advice the doctor gave (diet, rest, warning signs to come back for): {text, turn_index, quote}
- follow_up: when to come back, as the doctor said: {text, turn_index, quote}
- assessment: what the doctor said the problem is, in their words: {text, turn_index, quote}
Write every text field (assessment, tests, advice, follow_up) as a short English phrase,
translated if the doctor spoke Hindi or another language.
turn_index is the [n] of the turn that says it; quote is copied EXACTLY from that turn (original
language and script). Return empty lists for anything the doctor did not say."""


def format_transcript(turns: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"[{t['turn_index']}] SPEAKER {t['speaker'] if t['speaker'] is not None else '?'}: {t['text']}" for t in turns
    )


def extract_prescription(turns: list[dict[str, Any]], extract=llm.extract) -> tuple[dict[str, Any], list[dict[str, Any]], str, int | None]:
    """Returns (draft, rejected, model, doctor_speaker). Every kept item carries {turn_index, quote}."""
    result = extract(format_transcript(turns), LlmPrescription, INSTRUCTIONS)
    by_index = {t["turn_index"]: t for t in turns}
    threshold = get_settings().span_match_threshold
    draft: dict[str, Any] = {k: [] for k in SECTIONS}
    rejected: list[dict[str, Any]] = []
    for section in SECTIONS:
        schema = MedicineCandidate if section == "medicines" else TextCandidate
        for raw in getattr(result.data, section):
            try:
                c = schema.model_validate(raw)
            except ValidationError as e:
                rejected.append({"section": section, "candidate": raw, "reason": "invalid_candidate", "detail": str(e)[:300]})
                continue
            turn = by_index.get(c.turn_index)
            score, matched = align_span(c.quote, turn["text"]) if turn else (0.0, None)
            if matched is None or score < threshold:
                rejected.append({"section": section, "candidate": raw, "reason": "quote_not_in_transcript",
                                 "detail": f"score {score:.2f}"})
                continue
            item = c.model_dump(exclude={"quote", "turn_index"})
            draft[section].append({**{k: (v.strip() if isinstance(v, str) else v) for k, v in item.items()},
                                   "evidence": {"turn_index": c.turn_index, "quote": matched}})
    speaker = result.data.doctor_speaker
    known = {t["speaker"] for t in turns}
    return draft, rejected, result.model, speaker if speaker in known else None


def run_scribe(db: Session, org_id: uuid.UUID, consultation_id: uuid.UUID, transcribe=None, extract=llm.extract) -> dict[str, int]:
    """Transcribe (recordings only), then extract the draft. The report starts as the draft."""
    from app import storage
    from app.scribe import sarvam

    c = ConsultationRepository(db, org_id).get(consultation_id)
    if c is None:
        raise LookupError("consultation not found")
    if c.source == "recording" and not c.transcript:
        c.transcript = (transcribe or sarvam.transcribe)(storage.path(c.recording_key))
        db.flush()
    if not c.transcript:
        raise ValueError("the transcript is empty: nothing was heard")
    draft, rejected, model, speaker = extract_prescription(c.transcript, extract)
    c.draft, c.rejected, c.extracted_by, c.doctor_speaker = draft, rejected, model, speaker
    c.report = {**{k: [dict(i) for i in v] for k, v in draft.items()}, "notes": ""}
    c.status, c.error = "draft", None
    db.flush()
    return {"accepted": sum(len(v) for v in draft.values()), "rejected": len(rejected)}
