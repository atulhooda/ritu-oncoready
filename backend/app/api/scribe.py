"""The consultation scribe on the senior doctor's patient page: record the consultation (or paste a
transcript), get a prescription draft extracted from what the doctor said, edit it, approve it.
Approved prescriptions are kept on the patient's record: the doctors who can see the patient and
the patient themself can read them (`/prescriptions/{id}`, `/me/prescriptions`)."""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app import storage
from app.api.doctor import viewer
from app.auth.access import can_view, visible_case_or_404
from app.auth.deps import CurrentUser, get_current_user, require_role
from app.db import get_db
from app.intake import service
from app.models import Consultation, PatientCase, Role
from app.repositories.cases import CaseRepository
from app.repositories.consultations import ConsultationRepository
from app.repositories.reviews import CaseReviewRepository
from app.repositories.users import PractitionerProfileRepository, UserRepository
from app.scribe import sarvam
from app.scribe.extraction import MEDICINE_FIELDS, SECTIONS

router = APIRouter(tags=["scribe"])
doctor_only = require_role(Role.DOCTOR)
patient_only = require_role(Role.PATIENT)

AUDIO_TYPES = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav",
               "audio/x-wav": "wav", "audio/aac": "aac"}
MAX_CONSULTATION_BYTES = 150 * 1024 * 1024  # about two hours of browser (opus) audio
TYPED_LINE = re.compile(r"^\s*(doctor|dr\.?|patient|pt\.?)\s*[:\-]\s*(.+)$", re.I)


def _senior_case(db: Session, current: CurrentUser, case_id: uuid.UUID) -> PatientCase:
    """The senior doctor the junior sent this patient to. Only they record and approve."""
    case = visible_case_or_404(db, current, case_id)
    review = CaseReviewRepository(db, current.org_id).for_case(case.id)
    if review is None or review.status != "with_senior" or review.senior_user_id != current.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the senior doctor this patient was sent to can do this")
    return case


def _consultation(db: Session, current: CurrentUser, case: PatientCase, consultation_id: uuid.UUID) -> Consultation:
    c = ConsultationRepository(db, current.org_id).get(consultation_id)
    if c is None or c.case_id != case.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Consultation not found")
    return c


def _name(db: Session, org_id: uuid.UUID, user_id: uuid.UUID | None) -> str | None:
    u = UserRepository(db, org_id).get(user_id) if user_id else None
    return u.full_name if u else None


def consultation_out(db: Session, c: Consultation, full: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": c.id, "case_id": c.case_id, "status": c.status, "source": c.source, "error": c.error,
        "created_at": c.created_at, "updated_at": c.updated_at, "approved_at": c.approved_at,
        "doctor": {"id": c.doctor_user_id, "name": _name(db, c.org_id, c.doctor_user_id)},
        "has_recording": bool(c.recording_key), "report": c.report,
    }
    if full:
        role = lambda s: ("doctor" if s == c.doctor_speaker else "patient") if c.doctor_speaker is not None and s is not None else None  # noqa: E731
        out["transcript"] = [{**t, "role": role(t.get("speaker"))} for t in (c.transcript or [])]
        out["rejected"] = len(c.rejected or [])
        out["extracted_by"] = c.extracted_by
    return out


@router.get("/doctor/scribe")
def scribe_status(current: CurrentUser = Depends(doctor_only)) -> dict[str, bool]:
    """Whether recordings can be transcribed here (Sarvam connected), so the page can say so before
    a consultation is recorded rather than after."""
    return {"recording": sarvam.enabled()}


@router.get("/doctor/patients/{case_id}/consultations")
def list_consultations(case_id: uuid.UUID, current: CurrentUser = Depends(viewer), db: Session = Depends(get_db)):
    """The senior's own consultations (any status); everyone else who can see the patient: approved only."""
    case = visible_case_or_404(db, current, case_id)
    return [consultation_out(db, c) for c in ConsultationRepository(db, current.org_id).for_case(case.id)
            if c.status == "approved" or c.doctor_user_id == current.id]


@router.post("/doctor/patients/{case_id}/consultations", status_code=status.HTTP_201_CREATED)
def start_consultation(
    case_id: uuid.UUID,
    consent: bool = Form(...),
    file: UploadFile | None = File(None),
    transcript: str | None = Form(None, max_length=100_000),
    current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    """A recording of the consultation (`file`), or a typed transcript ("Doctor: ..." / "Patient: ..."
    lines). Only with the patient's agreement. Processing runs in the background."""
    from app.scribe.tasks import enqueue_consultation

    case = _senior_case(db, current, case_id)
    if not consent:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The patient must agree to the consultation being recorded")
    repo = ConsultationRepository(db, current.org_id)
    if file is not None:
        if not sarvam.enabled():
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Transcription is not connected (SARVAM_API_KEY). Paste a transcript instead.")
        mime = (file.content_type or "").split(";")[0].strip().lower()
        if mime not in AUDIO_TYPES:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Unsupported audio type")
        data = file.file.read(MAX_CONSULTATION_BYTES + 1)
        if not data or len(data) > MAX_CONSULTATION_BYTES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Recording missing or too large")
        cid = uuid.uuid4()
        key = f"{current.org_id}/{case.id}/consultations/{cid}.{AUDIO_TYPES[mime]}"
        storage.write_bytes(key, data)
        c = repo.add(id=cid, case_id=case.id, doctor_user_id=current.id, source="recording", recording_consent=True,
                     recording_key=key, recording_mime=mime)
    elif transcript and transcript.strip():
        turns = []
        for line in transcript.splitlines():
            m = TYPED_LINE.match(line)
            if m:
                speaker = 0 if m.group(1).lower().startswith("d") else 1
                turns.append({"turn_index": len(turns), "speaker": speaker, "text": m.group(2).strip()})
            elif line.strip() and turns:  # a continued line belongs to the turn above
                turns[-1]["text"] += " " + line.strip()
        if not turns:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, 'Start each line with "Doctor:" or "Patient:"')
        c = repo.add(case_id=case.id, doctor_user_id=current.id, source="typed", recording_consent=True, transcript=turns)
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Send a recording or a transcript")
    db.commit()
    enqueue_consultation(current.org_id, c.id)
    return consultation_out(db, c, full=True)


@router.get("/doctor/patients/{case_id}/consultations/{consultation_id}")
def get_consultation(case_id: uuid.UUID, consultation_id: uuid.UUID, current: CurrentUser = Depends(viewer), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)
    c = _consultation(db, current, case, consultation_id)
    if c.status != "approved" and c.doctor_user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Consultation not found")
    return consultation_out(db, c, full=True)


@router.get("/doctor/patients/{case_id}/consultations/{consultation_id}/recording", response_class=FileResponse)
def consultation_recording(case_id: uuid.UUID, consultation_id: uuid.UUID, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    case = visible_case_or_404(db, current, case_id)
    c = _consultation(db, current, case, consultation_id)
    if c.doctor_user_id != current.id or not c.recording_key or not storage.path(c.recording_key).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Recording not found")
    return FileResponse(storage.path(c.recording_key), media_type=c.recording_mime or "application/octet-stream")


class TextItem(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=500)
    evidence: dict[str, Any] | None = None


class MedicineItem(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=120)
    dose: str | None = Field(None, max_length=80)
    route: str | None = Field(None, max_length=40)
    frequency: str | None = Field(None, max_length=80)
    duration: str | None = Field(None, max_length=80)
    instructions: str | None = Field(None, max_length=300)
    evidence: dict[str, Any] | None = None


class ReportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assessment: list[TextItem] = Field(default_factory=list, max_length=30)
    medicines: list[MedicineItem] = Field(default_factory=list, max_length=60)
    tests: list[TextItem] = Field(default_factory=list, max_length=60)
    advice: list[TextItem] = Field(default_factory=list, max_length=60)
    follow_up: list[TextItem] = Field(default_factory=list, max_length=10)
    notes: str = Field("", max_length=5000)


def _clean_report(c: Consultation, body: ReportIn) -> dict[str, Any]:
    """The doctor's edits. An item keeps its link to the conversation only if that quote really is
    one the extraction verified (the client cannot invent evidence)."""
    verified = {(e["evidence"]["turn_index"], e["evidence"]["quote"]) for v in (c.draft or {}).values() for e in v}
    out: dict[str, Any] = {}
    for section in SECTIONS:
        items = []
        for item in getattr(body, section):
            d = item.model_dump()
            ev = d.get("evidence") or {}
            d["evidence"] = ev if (ev.get("turn_index"), ev.get("quote")) in verified else None
            if section == "medicines":
                d = {**{k: (d.get(k) or None) for k in MEDICINE_FIELDS}, "evidence": d["evidence"]}
            items.append(d)
        out[section] = items
    out["notes"] = body.notes.strip()
    return out


@router.put("/doctor/patients/{case_id}/consultations/{consultation_id}/report")
def save_report(case_id: uuid.UUID, consultation_id: uuid.UUID, body: ReportIn,
                current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    case = _senior_case(db, current, case_id)
    c = _consultation(db, current, case, consultation_id)
    if c.doctor_user_id != current.id or c.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a draft can be changed, by the doctor who recorded it")
    c.report, c.updated_at = _clean_report(c, body), datetime.now(UTC)
    db.commit()
    return consultation_out(db, c, full=True)


@router.post("/doctor/patients/{case_id}/consultations/{consultation_id}/approve")
def approve(case_id: uuid.UUID, consultation_id: uuid.UUID, body: ReportIn,
            current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    """Save the doctor's final version and approve it. From now on it is read-only and the patient sees it."""
    case = _senior_case(db, current, case_id)
    c = _consultation(db, current, case, consultation_id)
    if c.doctor_user_id != current.id or c.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a draft can be approved, by the doctor who recorded it")
    report = _clean_report(c, body)
    if not any(report[s] for s in SECTIONS) and not report["notes"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The prescription is empty")
    p = PractitionerProfileRepository(db, current.org_id).get_for(current.id)
    report["prescriber"] = {  # as it was when approved
        "name": _name(db, current.org_id, current.id),
        "qualification": p.qualification if p else None,
        "registration_number": p.registration_number if p else None,
        "medical_council": p.medical_council if p else None,
    }
    now = datetime.now(UTC)
    c.report, c.updated_at, c.status, c.approved_at, c.approved_by = report, now, "approved", now, current.id
    db.commit()
    return consultation_out(db, c, full=True)


@router.post("/doctor/patients/{case_id}/consultations/{consultation_id}/retry")
def retry(case_id: uuid.UUID, consultation_id: uuid.UUID, current: CurrentUser = Depends(doctor_only), db: Session = Depends(get_db)):
    from app.scribe.tasks import enqueue_consultation

    case = _senior_case(db, current, case_id)
    c = _consultation(db, current, case, consultation_id)
    if c.doctor_user_id != current.id or c.status != "failed":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a failed consultation can be retried")
    c.status, c.error = "processing", None
    db.commit()
    enqueue_consultation(current.org_id, c.id)
    return consultation_out(db, c)


def prescription_out(db: Session, c: Consultation) -> dict[str, Any]:
    case = CaseRepository(db, c.org_id).get(c.case_id)
    patient = UserRepository(db, c.org_id).get(case.patient_user_id)
    details = service.patient_details(db, c.org_id, case.patient_user_id)
    from app.repositories.orgs import OrgRepository

    org = OrgRepository(db).get(c.org_id)
    return {
        "id": c.id, "case_id": c.case_id, "approved_at": c.approved_at, "clinic": org.name if org else None,
        "patient": {"name": case.title, "patient_number": patient.patient_number if patient else None,
                    "age": details["age"], "sex": details["sex"]},
        "report": c.report,
    }


@router.get("/prescriptions/{consultation_id}")
def get_prescription(consultation_id: uuid.UUID, current: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """An approved prescription, for the patient it belongs to and the doctors who can see them."""
    c = ConsultationRepository(db, current.org_id).get(consultation_id)
    case = CaseRepository(db, current.org_id).get(c.case_id) if c else None
    review = CaseReviewRepository(db, current.org_id).for_case(c.case_id) if c else None
    if c is None or c.status != "approved" or case is None or not can_view(current, case, review):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Prescription not found")
    return prescription_out(db, c)


@router.get("/me/prescriptions")
def my_prescriptions(current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    case = CaseRepository(db, current.org_id).for_patient(current.id)
    if case is None:
        return []
    return [prescription_out(db, c) for c in ConsultationRepository(db, current.org_id).approved_for_case(case.id)]
