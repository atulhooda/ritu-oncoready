import re
import secrets
import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import IntakeSession, PatientCase, User
from app.models.intake import FACT_SECTIONS
from app.repositories.cases import CaseRepository, SourceDocumentRepository
from app.repositories.intake import (
    IntakeFactRepository,
    IntakeSessionRepository,
    PatientProfileRepository,
    SessionTurnRepository,
)
from app.voice import client as ritu
from app.intake.urgent import is_urgent
from app.voice.script import build_check_in_script, build_intake_script

SECTION_LABELS = {
    "current_symptom": "Current symptoms",
    "treatment": "Cancer treatment",
    "medication": "Current medicines",
    "allergy": "Allergies",
    "recent_care": "Hospital or emergency visits",
    "past_history": "Past history",
    "previous_record": "Previous records mentioned",
    "concern": "What they want to ask the doctor",
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


DETAIL_FIELDS = (
    "date_of_birth", "sex", "phone", "preferred_language", "cancer_type", "diagnosed_on", "stage_reported",
    "treatment_status", "current_treatment", "treating_hospital", "treating_doctor", "other_conditions",
)


def age_on(dob: date | None, today: date) -> int | None:
    if dob is None:
        return None
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def patient_details(db: Session, org_id: uuid.UUID, patient_user_id: uuid.UUID) -> dict[str, Any]:
    """Patient-reported details (empty fields when the patient hasn't filled them in)."""
    p = PatientProfileRepository(db, org_id).get_for(patient_user_id)
    out: dict[str, Any] = {f: getattr(p, f) if p else None for f in DETAIL_FIELDS}
    out["preferred_language"] = out["preferred_language"] or "en-IN"
    out["age"] = age_on(out["date_of_birth"], date.today())
    out["updated_at"] = p.updated_at or p.created_at if p else None
    out["abha"] = abha_link(p)
    return out


def abha_link(p) -> dict[str, Any] | None:
    if p is None or p.abha_verified_at is None:
        return None
    return {"number": p.abha_number_masked, "address": p.abha_address, "name": p.abha_name,
            "verified_at": p.abha_verified_at, "verified_via": p.abha_verified_via}


def link_abha(db: Session, user: User, account, verified_via: str) -> dict[str, Any] | None:
    """Store an ABHA after a completed OTP check (app/identity/abdm.py). Only the last 4 digits are kept."""
    from app.identity.abdm import masked

    profiles = PatientProfileRepository(db, user.org_id)
    p = profiles.get_for(user.id) or profiles.add(patient_user_id=user.id)
    p.abha_number_masked, p.abha_address, p.abha_name = masked(account.abha_number), account.abha_address, account.name
    p.abha_verified_at, p.abha_verified_via = datetime.now(UTC), verified_via
    db.flush()
    return abha_link(p)


def unlink_abha(db: Session, user: User) -> None:
    p = PatientProfileRepository(db, user.org_id).get_for(user.id)
    if p is not None:
        p.abha_number_masked = p.abha_address = p.abha_name = p.abha_verified_at = p.abha_verified_via = None
        db.flush()


def update_details(db: Session, user: User, values: dict[str, Any]) -> dict[str, Any]:
    profiles = PatientProfileRepository(db, user.org_id)
    p = profiles.get_for(user.id) or profiles.add(patient_user_id=user.id)
    for k, v in values.items():
        if k in DETAIL_FIELDS:
            setattr(p, k, v)
    db.flush()
    return patient_details(db, user.org_id, user.id)


def previous_symptoms(db: Session, org_id: uuid.UUID, case_id: uuid.UUID) -> list[dict[str, Any]]:
    """Symptoms the patient reported before, newest first, each label once with its latest details.
    Urgent ones and the worst scores come first, so a check-in follows up what matters most."""
    seen: dict[str, dict[str, Any]] = {}
    for summary in session_history(db, org_id, case_id):
        for section in summary["sections"]:
            if section["section"] != "current_symptom":
                continue
            for f in section["facts"]:
                seen.setdefault(f["label"].lower(), {"label": f["label"], "details": f["details"], "urgent": f["urgent"]})
    items = list(seen.values())
    return sorted(items, key=lambda p: (not p["urgent"], -(score_of(p["details"]) or -1)))


def script_for(db: Session, org_id: uuid.UUID, patient_user_id: uuid.UUID, case_id: uuid.UUID, kind: str) -> dict[str, Any]:
    details = patient_details(db, org_id, patient_user_id)
    if kind == "check_in":
        return build_check_in_script(details, previous_symptoms(db, org_id, case_id))
    return build_intake_script(details)


def start_session(
    db: Session, user: User, language: str | None = None, record_audio: bool = False, kind: str = "pre_visit"
) -> tuple[IntakeSession, ritu.BrowserSession | None]:
    case = profile_case(db, user)
    details = patient_details(db, user.org_id, user.id)
    language = language or details["preferred_language"]
    mode = "ritu" if ritu.enabled() else "simulator"
    script = script_for(db, user.org_id, user.id, case.id, kind)  # before the new session exists
    session = IntakeSessionRepository(db, user.org_id).add(
        case_id=case.id, patient_user_id=user.id, mode=mode, kind=kind, language=language, status="created",
        recording_consent=record_audio and mode == "ritu",  # only voice sessions have audio
    )
    connection = None
    if mode == "ritu":
        try:
            connection = ritu.create_browser_session(user.org_id, session.id, user.full_name, language, script)
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
    """The latest summarized pre-visit history (what the patient reviews before sending)."""
    session = IntakeSessionRepository(db, org_id).latest_summarized(case_id, kind="pre_visit")
    return summarize_session(db, org_id, session) if session else None


def session_history(
    db: Session, org_id: uuid.UUID, case_id: uuid.UUID, kind: str | None = None
) -> list[dict[str, Any]]:
    """Every summarized conversation (of one kind, or all), newest first. A later "nothing new"
    conversation must not hide what the patient said earlier, so doctors get all of them."""
    return [summarize_session(db, org_id, s) for s in IntakeSessionRepository(db, org_id).summarized(case_id, kind=kind)]


def score_of(details: dict[str, Any]) -> float | None:
    """The 0-10 number in "7/10" (or a bare "7"), when the patient gave one."""
    m = re.search(r"(\d+(?:\.\d+)?)", details.get("score") or "")
    n = float(m.group(1)) if m else None
    return n if n is not None and 0 <= n <= 10 else None


MAX_COURSE_SESSIONS = 8


def symptom_course(history: list[dict[str, Any]]) -> dict[str, Any]:
    """Each symptom across conversations, oldest to newest (the last MAX_COURSE_SESSIONS), matched by
    label. A blank cell means it was not mentioned in that conversation, not that it has gone."""
    sessions = list(reversed(history[:MAX_COURSE_SESSIONS]))
    rows: dict[str, dict[str, Any]] = {}
    for i, summary in enumerate(sessions):
        for section in summary["sections"]:
            if section["section"] != "current_symptom":
                continue
            for f in section["facts"]:
                row = rows.setdefault(f["label"].lower(), {"label": f["label"], "urgent": False, "cells": [None] * len(sessions)})
                row["label"] = f["label"]  # newest wording
                row["urgent"] = row["urgent"] or f["urgent"]
                row["cells"][i] = {
                    "fact_id": f["id"], "score": score_of(f["details"]), "trend": f["details"].get("trend"),
                    "severity": f["details"].get("severity"), "urgent": f["urgent"],
                }
    # newest reports first: rows mentioned in the latest conversation lead
    ordered = sorted(rows.values(), key=lambda r: (not r["urgent"], -max((i for i, c in enumerate(r["cells"]) if c), default=-1)))
    return {
        "sessions": [{"session_id": s["session_id"], "kind": s["kind"], "ended_at": s["ended_at"]} for s in sessions],
        "rows": ordered,
    }


def current_symptom_labels(history: list[dict[str, Any]]) -> list[str]:
    """Current symptoms across all conversations, newest first, each label once."""
    seen, out = set(), []
    for summary in history:
        for section in summary["sections"]:
            if section["section"] != "current_symptom":
                continue
            for f in section["facts"]:
                if f["label"].lower() not in seen:
                    seen.add(f["label"].lower())
                    out.append(f["label"])
    return out


def summarize_session(db: Session, org_id: uuid.UUID, session) -> dict[str, Any]:
    """Deterministic summary of one conversation: facts grouped by section in a fixed order, each
    with the patient's own words. No interpretation is added."""
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
                {"id": f.id, "label": f.label, "urgent": is_urgent(f.label, f.details),
                 "details": {k: v for k, v in f.details.items() if k != "evidence"},
                 "quote": f.source_text_span, "turn_index": turns[f.source_turn_id].turn_index,
                 # every verified quote about this problem, primary first
                 "evidence": [{"turn_index": turns[f.source_turn_id].turn_index, "quote": f.source_text_span}]
                 + list(f.details.get("evidence", []))}
                for f in facts if f.section == key
            ],
        }
        for key in FACT_SECTIONS
    ]
    return {
        "session_id": session.id, "kind": session.kind, "mode": session.mode, "language": session.language,
        "has_recording": bool(session.recording_key),
        "started_at": session.started_at, "ended_at": session.ended_at, "extracted_by": session.extracted_by,
        "sections": sections,
        "transcript": [{"turn_index": t.turn_index, "role": t.role, "text": t.text}
                       for t in sorted(turns.values(), key=lambda t: t.turn_index)],
    }


def publish(db: Session, user: User) -> PatientCase:
    case = profile_case(db, user)
    if IntakeSessionRepository(db, user.org_id).latest_summarized(case.id, kind="pre_visit") is None:
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
