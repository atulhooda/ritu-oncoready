"""Doctor profile: their professional details, and patients who sent their Ritu session summary and records."""

import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.assistant.answer import answer_question
from app.auth.access import visible_case_or_404
from app.auth.deps import CurrentUser, require_role
from app import storage
from app.db import get_db
from app.intake import service
from app.models import Role
from app.pipeline.derive import facts_for_case, lab_flags
from app.repositories.cases import CaseRepository, SourceDocumentRepository
from app.repositories.intake import IntakeSessionRepository
from app.repositories.timeline import DiscrepancyRepository, PendingTestRepository
from app.repositories.users import PractitionerProfileRepository, UserRepository
from app.voice import client as ritu
from app.services.timeline import build_timeline

router = APIRouter(prefix="/doctor", tags=["doctor"])
doctor_only = require_role(Role.DOCTOR)


class PractitionerIn(BaseModel):
    """Self-declared professional details. Blank strings are stored as empty."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    hpr_id: str | None = Field(None, max_length=20)
    registration_number: str | None = Field(None, max_length=40, pattern=r"^[A-Za-z0-9/\- ]*$")
    medical_council: str | None = Field(None, max_length=120)
    qualification: str | None = Field(None, max_length=200)

    @field_validator("*", mode="before")
    @classmethod
    def blank_is_none(cls, v):
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("hpr_id")
    @classmethod
    def hpr_14_digits(cls, v: str | None) -> str | None:
        if v is None:
            return None
        digits = re.sub(r"[\s-]", "", v)
        if not re.fullmatch(r"\d{14}", digits):
            raise ValueError("An HPR ID has 14 digits")
        return digits


PRACTITIONER_FIELDS = ("hpr_id", "registration_number", "medical_council", "qualification")


def _practitioner_out(db: Session, current: CurrentUser) -> dict[str, Any]:
    user = UserRepository(db, current.org_id).get(current.id)
    p = PractitionerProfileRepository(db, current.org_id).get_for(current.id)
    out: dict[str, Any] = {"name": user.full_name, "email": user.email, "verified": False}  # self-declared
    out.update({f: getattr(p, f) if p else None for f in PRACTITIONER_FIELDS})
    return out


@router.get("/me")
def get_me(current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    return _practitioner_out(db, current)


@router.put("/me")
def update_me(body: PractitionerIn, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    repo = PractitionerProfileRepository(db, current.org_id)
    p = repo.get_for(current.id) or repo.add(user_id=current.id)
    for k, v in body.model_dump().items():
        setattr(p, k, v)
    db.commit()
    return _practitioner_out(db, current)


@router.get("/patients")
def list_patients(current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    out = []
    for case in CaseRepository(db, current.org_id).published_intake():
        history = service.session_history(db, current.org_id, case.id)
        check_ins = [h for h in history if h["kind"] == "check_in"]
        details = service.patient_details(db, current.org_id, case.patient_user_id)
        out.append({
            "case_id": case.id,
            "name": case.title,
            "patient_number": UserRepository(db, current.org_id).get(case.patient_user_id).patient_number,
            "age": details["age"],
            "sex": details["sex"],
            "cancer_type": details["cancer_type"],
            "abha_verified_via": details["abha"]["verified_via"] if details["abha"] else None,
            "published_at": case.published_at,
            "symptoms": service.current_symptom_labels(history),
            "conversations": len(history),
            "check_ins": len(check_ins),
            "last_check_in": {
                "ended_at": check_ins[0]["ended_at"],
                "urgent": [f["label"] for sec in check_ins[0]["sections"] for f in sec["facts"] if f["urgent"]],
            } if check_ins else None,
            "records": len(SourceDocumentRepository(db, current.org_id).for_case(case.id)),
            "pending_tests": len(PendingTestRepository(db, current.org_id).for_case(case.id)),
            "discrepancies": len(DiscrepancyRepository(db, current.org_id).for_case(case.id)),
            "flags": len(lab_flags(facts_for_case(db, current.org_id, case.id))),
        })
    return out


@router.get("/patients/{case_id}")
def get_patient(case_id: uuid.UUID, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)  # published intake cases only
    history = service.session_history(db, current.org_id, case.id)
    return {
        "case_id": case.id,
        "name": case.title,
        "patient_number": UserRepository(db, current.org_id).get(case.patient_user_id).patient_number,
        "published_at": case.published_at,
        "details": service.patient_details(db, current.org_id, case.patient_user_id),
        "summary": service.build_summary(db, current.org_id, case.id),
        "sessions": history,
        "symptom_course": service.symptom_course(history),
        "records": service.records(db, current.org_id, case.id),
        "timeline": build_timeline(db, current.org_id, case.id),
    }


class AssistantQuestion(BaseModel):
    question: str = Field(min_length=2, max_length=500)


@router.post("/patients/{case_id}/assistant")
def ask_records_assistant(
    case_id: uuid.UUID, body: AssistantQuestion,
    current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    """RITU records assistant: answers from THIS patient's records only (app/assistant). Stateless:
    no conversation is kept on the server, so nothing carries over between patients."""
    case = visible_case_or_404(db, current, case_id)  # sent intake cases in the doctor's org only
    return answer_question(db, current.org_id, case.id, body.question.strip())


class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/assistant/speech", responses={200: {"content": {"audio/wav": {}}}})
def assistant_speech(body: SpeechIn, current: CurrentUser = Depends(doctor_only)) -> Response:
    """Read an assistant answer aloud in Ritu's Sarvam voice. 503 when Ritu is not connected
    (the browser then falls back to its own voice)."""
    if not ritu.enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Ritu voice is not connected")
    try:
        audio = ritu.synthesize(body.text)
    except ritu.RituError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


@router.get("/patients/{case_id}/sessions/{session_id}/recording", response_class=FileResponse)
def session_recording(
    case_id: uuid.UUID, session_id: uuid.UUID,
    current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db),
):
    case = visible_case_or_404(db, current, case_id)  # sent intake cases only
    session = IntakeSessionRepository(db, current.org_id).get(session_id)
    if session is None or session.case_id != case.id or not session.recording_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    path = storage.path(session.recording_key)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    return FileResponse(path, media_type=session.recording_mime or "application/octet-stream")
