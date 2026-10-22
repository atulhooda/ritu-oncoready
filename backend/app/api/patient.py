"""Patient profile: start a session with Ritu, upload previous records, send to the doctor."""

import uuid
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app import storage
from app.auth.deps import CurrentUser, require_role
from app.db import get_db
from app.intake import service, tasks as intake_tasks
from app.models import Role
from app.models.patient import LANGUAGES, SEXES, TREATMENT_STATUSES
from app.repositories.cases import SourceDocumentRepository
from app.repositories.intake import IntakeSessionRepository
from app.repositories.users import UserRepository
from app.voice.script import build_intake_script

router = APIRouter(prefix="/me", tags=["patient"])
patient_only = require_role(Role.PATIENT)
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
UPLOAD_TYPES = {b"%PDF": ("pdf", "application/pdf"), b"\x89PNG": ("png", "image/png"), b"\xff\xd8\xff": ("jpg", "image/jpeg")}


class StartSessionIn(BaseModel):
    record_audio: bool = False  # the patient ticked "record the audio for my care team"


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


def _user(db: Session, current: CurrentUser):
    return UserRepository(db, current.org_id).get(current.id)


def _session_out(s) -> dict[str, Any]:
    return {"id": s.id, "status": s.status, "mode": s.mode, "language": s.language,
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
        "sessions": [_session_out(s) for s in sessions],
        "summary": service.build_summary(db, user.org_id, case.id),
        "records": service.records(db, user.org_id, case.id),
    }


@router.put("/details")
def update_details(body: DetailsIn, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)):
    details = service.update_details(db, _user(db, current), body.model_dump())
    db.commit()
    return details


@router.get("/intake-script")
def intake_script(current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    return build_intake_script(service.patient_details(db, current.org_id, current.id))


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def start_session(
    body: StartSessionIn | None = None, current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)
) -> dict[str, Any]:
    try:
        session, connection = service.start_session(db, _user(db, current), record_audio=bool(body and body.record_audio))
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
    file: UploadFile = File(...), current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)
) -> dict[str, Any]:
    from app.pipeline.tasks import enqueue_document

    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "File too large (20 MB max)")
    kind = next((v for sig, v in UPLOAD_TYPES.items() if data.startswith(sig)), None)
    if kind is None:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Upload a PDF, PNG or JPEG")
    case = service.profile_case(db, _user(db, current))
    doc_id = uuid.uuid4()
    key = f"{current.org_id}/{case.id}/{doc_id}.{kind[0]}"
    storage.write_bytes(key, data)
    doc = SourceDocumentRepository(db, current.org_id).add(
        id=doc_id, case_id=case.id, filename=(file.filename or f"record.{kind[0]}")[:300], mime_type=kind[1],
        storage_key=key, uploaded_by_user_id=current.id,
    )
    db.commit()
    enqueue_document(current.org_id, doc.id, case.id)
    return {"id": doc.id, "filename": doc.filename, "status": doc.status}


@router.post("/publish")
def publish(current: CurrentUser = Depends(patient_only), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        case = service.publish(db, _user(db, current))
    except service.IntakeError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    db.commit()
    return {"published_at": case.published_at}
