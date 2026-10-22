"""Patient profile: talk to Ritu (pre-visit history, or a check-in between visits), upload previous
records, send to the doctor."""

import uuid
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app import storage
from app.auth.deps import CurrentUser, require_role
from app.db import get_db
from app.identity import abdm
from app.intake import service, tasks as intake_tasks, uploads
from app.models import Role
from app.models.intake import SESSION_KINDS
from app.models.patient import LANGUAGES, SEXES, TREATMENT_STATUSES
from app.repositories.cases import SourceDocumentRepository
from app.repositories.intake import IntakeSessionRepository
from app.repositories.users import UserRepository

router = APIRouter(prefix="/me", tags=["patient"])
patient_only = require_role(Role.PATIENT)
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_PAGES = 20


class StartSessionIn(BaseModel):
    record_audio: bool = False  # the patient ticked "record the audio for my care team"
    kind: Literal[*SESSION_KINDS] = "pre_visit"


AUDIO_TYPES = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav"}
MAX_RECORDING_BYTES = 40 * 1024 * 1024


class SimulatedTurn(BaseModel):
    role: Literal["patient", "ritu"]
    text: str = Field(min_length=1, max_length=4000)


class SimulatedTranscript(BaseModel):
    turns: list[SimulatedTurn] = Field(min_length=1, max_length=200)


class DetailsIn(BaseModel):
    """Everything the patient can say about themselves. Blank strings are stored as empty."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    date_of_birth: date | None = None
    sex: Literal[*SEXES] | None = None
    phone: str | None = Field(None, max_length=32, pattern=r"^[0-9+()\- ]*$")
    preferred_language: Literal[*LANGUAGES] = "en-IN"
    cancer_type: str | None = Field(None, max_length=120)
    diagnosed_on: date | None = None  # the UI sends the first day of the month
    stage_reported: str | None = Field(None, max_length=60)
    treatment_status: Literal[*TREATMENT_STATUSES] | None = None
    current_treatment: str | None = Field(None, max_length=2000)
    treating_hospital: str | None = Field(None, max_length=200)
    treating_doctor: str | None = Field(None, max_length=200)
    other_conditions: str | None = Field(None, max_length=2000)

    @field_validator("*", mode="before")
    @classmethod
    def blank_is_none(cls, v):
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("date_of_birth", "diagnosed_on")
    @classmethod
    def not_in_future(cls, v: date | None) -> date | None:
        if v is not None and (v > date.today() or v.year < 1900):
            raise ValueError("date must be in the past")
        return v


class AbhaOtpIn(BaseModel):
    abha_number: str = Field(max_length=20)


class AbhaVerifyIn(BaseModel):
    abha_number: str = Field(max_length=20)
    txn_id: str = Field(min_length=1, max_length=200)
    otp: str = Field(max_length=8)


def _user(db: Session, current: CurrentUser):
    return UserRepository(db, current.org_id).get(current.id)


def _session_out(s) -> dict[str, Any]:
    return {"id": s.id, "kind": s.kind, "status": s.status, "mode": s.mode, "language": s.language,
            "started_at": s.started_at, "ended_at": s.ended_at, "error": s.error,
            "recording_consent": s.recording_consent, "has_recording": bool(s.recording_key)}


@router.get("/profile")
def profile(current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    user = _user(db, current)
    case = service.profile_case(db, user)
    db.commit()
    sessions = sorted(IntakeSessionRepository(db, user.org_id).for_case(case.id), key=lambda s: s.created_at)
    return {
        "name": user.full_name,
        "email": user.email,
        "details": service.patient_details(db, user.org_id, user.id),
        "case_id": case.id,
        "published_at": case.published_at,
        "voice_mode": "ritu" if service.ritu.enabled() else "simulator",
        "abha_mode": abdm.mode(),  # abdm_sandbox | demo
        "sessions": [_session_out(s) for s in sessions],
        "summary": service.build_summary(db, user.org_id, case.id),
        # between-visit check-ins, newest first (shared with the care team once the profile is sent)
        "check_ins": service.session_history(db, user.org_id, case.id, kind="check_in"),
        "symptom_course": service.symptom_course(service.session_history(db, user.org_id, case.id)),
        "records": service.records(db, user.org_id, case.id),
    }


@router.put("/details")
def update_details(body: DetailsIn, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)):
    details = service.update_details(db, _user(db, current), body.model_dump())
    db.commit()
    return details


@router.post("/abha/otp")
def abha_otp(body: AbhaOtpIn, current: CurrentUser = Depends(patient_only)) -> dict[str, Any]:
    """Step 1 of linking an ABHA: ABDM sends an OTP to the mobile linked with it (sandbox, or demo)."""
    try:
        txn_id = abdm.request_otp(body.abha_number)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    except abdm.AbdmError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return {"txn_id": txn_id, "mode": abdm.mode(), "demo_otp": abdm.DEMO_OTP if abdm.mode() == "demo" else None}


@router.post("/abha/verify")
def abha_verify(body: AbhaVerifyIn, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)):
    """Step 2: the OTP checks out and ABDM returns this same ABHA, so it is linked to the profile."""
    try:
        account = abdm.verify_otp(body.txn_id, body.otp, body.abha_number)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    except abdm.AbdmError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e))
    link = service.link_abha(db, _user(db, current), account, abdm.mode())
    db.commit()
    return link


@router.delete("/abha", status_code=status.HTTP_204_NO_CONTENT)
def abha_unlink(current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)):
    service.unlink_abha(db, _user(db, current))
    db.commit()


@router.get("/intake-script")
def intake_script(
    kind: Literal[*SESSION_KINDS] = "pre_visit", current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)
) -> dict[str, Any]:
    case = service.profile_case(db, _user(db, current))
    db.commit()
    return service.script_for(db, current.org_id, current.id, case.id, kind)


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def start_session(
    body: StartSessionIn | None = None, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)
) -> dict[str, Any]:
    try:
        body = body or StartSessionIn()
        session, connection = service.start_session(db, _user(db, current), record_audio=body.record_audio, kind=body.kind)
    except service.IntakeError as e:
        db.commit()  # keep the failed session for the record
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    db.commit()
    out = _session_out(session)
    if connection is not None:  # the browser streams audio straight to Ritu with this short-lived token
        out["ritu"] = {"ws_url": connection.ws_url, "token": connection.token, "expires_at": connection.expires_at}
    return out


@router.get("/sessions/{session_id}")
def get_session(session_id: uuid.UUID, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)):
    session = IntakeSessionRepository(db, current.org_id).get(session_id)
    if session is None or session.patient_user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    return _session_out(session)


@router.post("/sessions/{session_id}/simulate")
def simulate(
    session_id: uuid.UUID, body: SimulatedTranscript,
    current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Typed stand-in for a Ritu voice session (only while Ritu browser sessions are not configured)."""
    session = IntakeSessionRepository(db, current.org_id).get(session_id)
    if session is None or session.patient_user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if session.mode != "simulator":
        raise HTTPException(status.HTTP_409_CONFLICT, "This session runs through Ritu voice")
    try:
        recorded = service.record_transcript(db, current.org_id, session, [t.model_dump() for t in body.turns])
    except service.IntakeError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    db.commit()
    if recorded:
        intake_tasks.enqueue_summary(current.org_id, session.id)
    return _session_out(session)


def _remux(path) -> None:
    """Browser recordings carry no duration header, so players cannot show length or seek. A stream
    copy through ffmpeg writes one. Best-effort: on any failure the original file stays."""
    import shutil
    import subprocess

    if not shutil.which("ffmpeg"):
        return
    tmp = path.with_suffix(".remux" + path.suffix)
    try:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-c", "copy", str(tmp)],
                       check=True, timeout=60, capture_output=True)
        tmp.replace(path)
    except (subprocess.SubprocessError, OSError):
        tmp.unlink(missing_ok=True)


@router.post("/sessions/{session_id}/recording", status_code=status.HTTP_201_CREATED)
def upload_recording(
    session_id: uuid.UUID, file: UploadFile = File(...),
    current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Audio the browser recorded during a voice session. Only with the consent given at the start."""
    session = IntakeSessionRepository(db, current.org_id).get(session_id)
    if session is None or session.patient_user_id != current.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found")
    if not session.recording_consent:
        raise HTTPException(status.HTTP_409_CONFLICT, "Recording was not agreed for this session")
    mime = (file.content_type or "").split(";")[0].strip().lower()
    if mime not in AUDIO_TYPES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Unsupported audio type")
    data = file.file.read(MAX_RECORDING_BYTES + 1)
    if not data or len(data) > MAX_RECORDING_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Recording missing or too large")
    key = f"{current.org_id}/{session.case_id}/sessions/{session.id}.{AUDIO_TYPES[mime]}"
    path = storage.write_bytes(key, data)
    _remux(path)
    session.recording_key, session.recording_mime = key, mime
    db.commit()
    return _session_out(session)


@router.post("/records", status_code=status.HTTP_202_ACCEPTED)
def upload_record(
    file: UploadFile | None = File(None),
    pages: list[UploadFile] | None = File(None),
    name: str | None = Form(None),
    current: CurrentUser = Depends(patient_only),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """One record per request: a PDF, a photo, or several photos (`pages`) saved as one document."""
    from app.pipeline.tasks import enqueue_document

    parts = ([file] if file else []) + list(pages or [])
    if not parts:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Nothing uploaded")
    if len(parts) > MAX_PAGES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"At most {MAX_PAGES} pages per document")
    blobs = []
    for part in parts:
        data = part.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (20 MB max)")
        blobs.append(data)
    if len(blobs) == 1 and uploads.is_pdf(blobs[0]):
        pdf = blobs[0]
    elif all(uploads.is_image(b) for b in blobs):
        try:
            pdf = uploads.images_to_pdf(blobs)
        except Exception:
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Could not read that image")
    else:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Upload a PDF, or photos (PNG or JPEG)")

    original = (parts[0].filename or "").rsplit(".", 1)[0]
    label = (name or "").strip() or (original if len(parts) == 1 and original else None)
    filename = f"{label or 'Photo ' + date.today().isoformat()}.pdf"[:300]
    case = service.profile_case(db, _user(db, current))
    doc_id = uuid.uuid4()
    key = f"{current.org_id}/{case.id}/{doc_id}.pdf"
    storage.write_bytes(key, pdf)
    doc = SourceDocumentRepository(db, current.org_id).add(
        id=doc_id, case_id=case.id, filename=filename, mime_type="application/pdf",
        storage_key=key, uploaded_by_user_id=current.id,
    )
    db.commit()
    enqueue_document(current.org_id, doc.id, case.id)
    return {"id": doc.id, "filename": doc.filename, "status": doc.status}


@router.delete("/records/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_record(document_id: uuid.UUID, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)):
    """Remove one of your own records: its file, page images, and everything read from it."""
    import shutil

    from app.pipeline.derive import run_derive

    case = service.profile_case(db, _user(db, current))
    docs = SourceDocumentRepository(db, current.org_id)
    doc = docs.get(document_id)
    if doc is None or doc.case_id != case.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Record not found")
    key = doc.storage_key
    docs.delete_where(docs.model.id == doc.id)  # pages, extracted facts and rejections cascade
    run_derive(db, current.org_id, case.id)  # pending tests / discrepancies no longer cite it
    db.commit()
    storage.path(key).unlink(missing_ok=True)
    shutil.rmtree(storage.path(storage.page_image_key(key, 1)).parent, ignore_errors=True)


@router.post("/publish")
def publish(current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        case = service.publish(db, _user(db, current))
    except service.IntakeError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    db.commit()
    return {"published_at": case.published_at}
