"""Transcript -> intake facts. The LLM proposes facts with a patient turn index and a quote;
code keeps a fact only if the quote is found (rapidfuzz >= span_match_threshold) in that
*patient* turn, and stores the aligned turn text. Failures are kept on the session for audit."""

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.llm import client as llm
from app.models.intake import FACT_SECTIONS
from app.pipeline.extraction import align_span
from app.repositories.intake import IntakeFactRepository, IntakeSessionRepository, SessionTurnRepository

DETAIL_KEYS = ("onset", "duration", "severity", "score", "location", "frequency", "triggers", "dose", "last_dose",
               "missed_doses", "record_type", "record_date", "facility", "notes")


class FactCandidate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    section: Literal[*FACT_SECTIONS]
    label: str = Field(min_length=1, max_length=300)
    turn_index: int = Field(ge=0)
    quote: str = Field(min_length=2, max_length=2000)
    details: dict[str, str | None] = Field(default_factory=dict)


class LlmFacts(BaseModel):
    facts: list[dict[str, Any]]


INSTRUCTIONS = f"""Below is a transcript of a pre-visit conversation between Ritu (an assistant) and a
patient. Extract what the PATIENT said into `facts`. Each fact:
- section: one of {list(FACT_SECTIONS)}
  current_symptom = a problem they have now, including treatment side effects; treatment = their
  cancer treatment (what, last dose or cycle, missed or delayed doses); medication = another medicine
  they currently take; allergy; recent_care = a hospital admission, emergency visit, test or scan
  since their last visit; past_history = earlier illnesses, operations, treatments; previous_record =
  a report, scan, prescription or discharge summary they say they have; concern = something they
  want to ask or discuss with their doctor.
- label: a short, neutral English restatement (e.g. "Breathlessness on climbing stairs").
  If they gave a 0-10 score, put it in details.score (e.g. "7/10").
- turn_index: the [n] of the PATIENT turn the fact comes from.
- quote: the patient's words copied EXACTLY from that turn (keep the original language).
- details: optional strings, only if the patient said them: {list(DETAIL_KEYS)}.
Only use what the patient said. Do not add diagnoses, causes, interpretations, or advice.
Return {{"facts": []}} if there is nothing."""


def format_transcript(turns) -> str:
    return "\n".join(f"[{t.turn_index}] {t.role.upper()}: {t.text}" for t in turns)


def run_intake_extraction(db: Session, org_id: uuid.UUID, session_id: uuid.UUID, extract=llm.extract) -> dict[str, int]:
    session = IntakeSessionRepository(db, org_id).get(session_id)
    if session is None:
        raise LookupError("session not found")
    turns = {t.turn_index: t for t in SessionTurnRepository(db, org_id).for_session(session.id)}
    facts = IntakeFactRepository(db, org_id)
    facts.delete_where(facts.model.session_id == session.id)  # re-running replaces earlier output

    result = extract(format_transcript(turns.values()), LlmFacts, INSTRUCTIONS)
    threshold = get_settings().span_match_threshold
    accepted, rejected = 0, []
    for raw in result.data.facts:
        try:
            c = FactCandidate.model_validate(raw)
        except ValidationError as e:
            rejected.append({"candidate": raw, "reason": "invalid_candidate", "detail": str(e)[:500]})
            continue
        turn = turns.get(c.turn_index)
        if turn is None or turn.role != "patient":
            rejected.append({"candidate": raw, "reason": "not_a_patient_turn"})
            continue
        score, matched = align_span(c.quote, turn.text)
        if matched is None or score < threshold:
            rejected.append({"candidate": raw, "reason": "quote_not_in_turn", "detail": f"score {score:.2f}"})
            continue
        facts.add(
            session_id=session.id, case_id=session.case_id, section=c.section, label=c.label.strip(),
            details={k: v for k, v in c.details.items() if k in DETAIL_KEYS and v},
            source_turn_id=turn.id, source_text_span=matched, extracted_by=result.model,
        )
        accepted += 1
    session.rejected_facts = rejected
    session.extracted_by = result.model
    session.status = "summarized"
    session.error = None
    db.flush()
    return {"accepted": accepted, "rejected": len(rejected)}
