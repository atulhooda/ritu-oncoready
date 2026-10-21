import secrets
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import IntakeSession, PatientCase, User
from app.models.intake import FACT_SECTIONS
from app.repositories.cases import CaseRepository, SourceDocumentRepository
from app.repositories.intake import IntakeFactRepository, IntakeSessionRepository, SessionTurnRepository
from app.voice import client as ritu

SECTION_LABELS = {
    "current_symptom": "Current symptoms",
    "medication": "Current medicines",
    "allergy": "Allergies",
    "past_history": "Past history",
    "previous_record": "Previous records mentioned",
}


class IntakeError(ValueError):
    pass


def profile_case(db: Session, user: User) -> PatientCase:
    """The patient's own intake case, created on first use."""
    cases = CaseRepository(db, user.org_id)
    case = cases.for_patient(user.id)
    if case is None:
        case = cases.add(
            case_code=f"PT-{secrets.token_hex(3).upper()}", title=user.full_name, kind="intake",
            patient_user_id=user.id, created_by_user_id=user.id, status="published",
            summary="Demo patient profile (synthetic persona).",
        )
    return case


def start_session(db: Session, user: User, language: str = "en") -> tuple[IntakeSession, ritu.BrowserSession | None]:
    case = profile_case(db, user)
    mode = "ritu" if ritu.enabled() else "simulator"
    session = IntakeSessionRepository(db, user.org_id).add(
        case_id=case.id, patient_user_id=user.id, mode=mode, language=language, status="created"
    )
    connection = None
    if mode == "ritu":
        try:
            connection = ritu.create_browser_session(user.org_id, session.id, user.full_name, language)
        except ritu.RituError as e:
            session.status, session.error = "failed", str(e)[:2000]
            db.flush()
            raise IntakeError(str(e)) from e
        session.ritu_session_id = connection.session_id
    session.status = "in_progress"
    session.started_at = datetime.now(UTC)
    db.flush()
    return session, connection


def record_transcript(
    db: Session, org_id: uuid.UUID, session: IntakeSession, turns: list[dict[str, Any]],
    started_at: datetime | None = None, ended_at: datetime | None = None,
) -> bool:
    """Store the finished conversation. Returns False if it was already recorded (idempotent)."""
    repo = SessionTurnRepository(db, org_id)
    if session.status in ("completed", "summarized") or repo.for_session(session.id):
        return False
    if session.status not in ("created", "in_progress"):
        raise IntakeError(f"session is {session.status}")
    if not any(t["role"] == "patient" and t["text"].strip() for t in turns):
        raise IntakeError("transcript has no patient speech")
    for n, t in enumerate(turns):
        repo.add(session_id=session.id, turn_index=n, role=t["role"], text=t["text"], spoken_at=t.get("time"))
    session.status = "completed"
    session.started_at = started_at or session.started_at
    session.ended_at = ended_at or datetime.now(UTC)
    db.flush()
    return True


def build_summary(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> dict[str, Any] | None:
    """Deterministic summary of the latest summarized session: facts grouped by section in a fixed
    order, each with the patient's own words. No interpretation is added."""
    session = IntakeSessionRepository(db, org_id).latest_summarized(case_id)
    if session is None:
        return None
    turns = {t.id: t for t in SessionTurnRepository(db, org_id).for_session(session.id)}
    facts = sorted(
        IntakeFactRepository(db, org_id).for_session(session.id),
        key=lambda f: (FACT_SECTIONS.index(f.section), turns[f.source_turn_id].turn_index, f.label),
    )
    sections = [
        {
            "section": key,
            "label": SECTION_LABELS[key],
            "facts": [
                {"id": f.id, "label": f.label, "details": f.details, "quote": f.source_text_span,
                 "turn_index": turns[f.source_turn_id].turn_index}
                for f in facts if f.section == key
            ],
        }
        for key in FACT_SECTIONS
    ]
    return {
        "session_id": session.id, "mode": session.mode, "language": session.language,
        "started_at": session.started_at, "ended_at": session.ended_at, "extracted_by": session.extracted_by,
        "sections": sections,
        "transcript": [{"turn_index": t.turn_index, "role": t.role, "text": t.text}
                       for t in sorted(turns.values(), key=lambda t: t.turn_index)],
    }


def publish(db: Session, user: User) -> PatientCase:
    case = profile_case(db, user)
    if IntakeSessionRepository(db, user.org_id).latest_summarized(case.id) is None:
        raise IntakeError("finish a session with Ritu before sending to the doctor")
    case.published_at = datetime.now(UTC)
    db.flush()
    return case


def records(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> list[dict[str, Any]]:
    return [
        {"id": d.id, "filename": d.filename, "status": d.status, "page_count": d.page_count,
         "uploaded_at": d.created_at, "error": d.error}
        for d in SourceDocumentRepository(db, org_id).for_case(case_id)
    ]
