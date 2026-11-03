"""Doctors' work: their professional details, and the patients assigned to them (junior) or sent to
them (senior), with the Ritu session summary, records and the junior's summary for the senior.
The hospital account uses the same read-only patient views (app/auth/access.py decides who sees what)."""

import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.assistant.answer import answer_question
from app.auth.access import visible_case_or_404, visible_cases
from app.auth.deps import CurrentUser, require_role
from app import storage
from app.db import get_db
from app.intake import service
from app.models import Role
from app.pipeline.derive import facts_for_case, lab_flags
from app.repositories.cases import CaseRepository, SourceDocumentRepository
from app.repositories.intake import IntakeSessionRepository
from app.repositories.reviews import CaseReviewRepository
from app.repositories.timeline import DiscrepancyRepository, PendingTestRepository
from app.repositories.users import PractitionerProfileRepository, UserRepository
from app.voice import client as ritu
from app.services import review as reviews
from app.services.timeline import build_timeline

router = APIRouter(prefix="/doctor", tags=["doctor"])
doctor_only = require_role(Role.DOCTOR)
viewer = require_role(Role.DOCTOR, Role.HOSPITAL)


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


def patient_row(db: Session, org_id: uuid.UUID, case) -> dict[str, Any]:
    history = service.session_history(db, org_id, case.id)
    check_ins = [h for h in history if h["kind"] == "check_in"]
    details = service.patient_details(db, org_id, case.patient_user_id)
    review = CaseReviewRepository(db, org_id).for_case(case.id)
    return {
        "case_id": case.id,
        "name": case.title,
        "patient_number": UserRepository(db, org_id).get(case.patient_user_id).patient_number,
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
        "records": len(SourceDocumentRepository(db, org_id).for_case(case.id)),
        "pending_tests": len(PendingTestRepository(db, org_id).for_case(case.id)),
        "discrepancies": len(DiscrepancyRepository(db, org_id).for_case(case.id)),
        "flags": len(lab_flags(facts_for_case(db, org_id, case.id))),
        "review": {
            "status": review.status if review else "unassigned",
            "junior": reviews.doctor_name(db, org_id, review.junior_user_id) if review else None,
            "senior": reviews.doctor_name(db, org_id, review.senior_user_id) if review else None,
            "sent_at": review.sent_at if review else None,
        },
    }


@router.get("/patients")
def list_patients(current: CurrentUser = Depends(viewer), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """A junior's assigned patients, or the summaries sent to a senior (the hospital: everyone)."""
    return [patient_row(db, current.org_id, case) for case in visible_cases(db, current)]


@router.get("/patients/{case_id}")
def get_patient(case_id: uuid.UUID, current: CurrentUser = Depends(viewer), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)  # assigned / sent to this doctor only
    history = service.session_history(db, current.org_id, case.id)
    review = CaseReviewRepository(db, current.org_id).for_case(case.id)
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
        "review": reviews.review_out(db, current.org_id, case, review),
    }


@router.get("/seniors")
def list_seniors(current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [{"id": u.id, "name": u.full_name} for u in UserRepository(db, current.org_id).doctors()
            if u.seniority == "senior" and u.is_active]


class SummaryIn(BaseModel):
    """The structured summary: ticked points from the patient's report and the junior's notes."""

    model_config = ConfigDict(extra="forbid")

    facts: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    findings: str = Field("", max_length=reviews.MAX_NOTE)
    concerns: str = Field("", max_length=reviews.MAX_NOTE)
    questions: str = Field("", max_length=reviews.MAX_NOTE)


class SendIn(SummaryIn):
    senior_user_id: uuid.UUID


def _review_change(db: Session, current: CurrentUser, case, change) -> dict[str, Any]:
    try:
        review = change()
    except reviews.ReviewError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    db.commit()
    return reviews.review_out(db, current.org_id, case, review)


@router.put("/patients/{case_id}/summary")
def save_summary(case_id: uuid.UUID, body: SummaryIn, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)
    return _review_change(db, current, case, lambda: reviews.save_summary(
        db, current.org_id, case, current.id, body.model_dump(include={"facts", *reviews.NOTES})))


@router.post("/patients/{case_id}/send")
def send_to_senior(case_id: uuid.UUID, body: SendIn, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)
    return _review_change(db, current, case, lambda: reviews.send_to_senior(
        db, current.org_id, case, current.id, body.senior_user_id, body.model_dump(include={"facts", *reviews.NOTES})))


class AssistantQuestion(BaseModel):
    question: str = Field(min_length=2, max_length=500)


@router.post("/patients/{case_id}/assistant")
def ask_records_assistant(
    case_id: uuid.UUID, body: AssistantQuestion,
    current: CurrentUser = Depends(viewer), db: Session = Depends(get_db),
) -> dict[str, Any]:
    """RITU records assistant: answers from THIS patient's records only (app/assistant). Stateless:
    no conversation is kept on the server, so nothing carries over between patients."""
    case = visible_case_or_404(db, current, case_id)  # assigned / sent to this doctor only
    return answer_question(db, current.org_id, case.id, body.question.strip())


class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/assistant/speech", responses={200: {"content": {"audio/wav": {}}}})
def assistant_speech(body: SpeechIn, current: CurrentUser = Depends(viewer)) -> Response:
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
    current: CurrentUser = Depends(viewer), db: Session = Depends(get_db),
):
    case = visible_case_or_404(db, current, case_id)  # sent intake cases only
    session = IntakeSessionRepository(db, current.org_id).get(session_id)
    if session is None or session.case_id != case.id or not session.recording_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    path = storage.path(session.recording_key)
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    return FileResponse(path, media_type=session.recording_mime or "application/octet-stream")
