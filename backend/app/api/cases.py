import uuid
from datetime import datetime

from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app import storage
from app.auth.deps import CurrentUser, ensure_case_unlocked, get_current_user, require_role
from app.db import get_db
from app.models import Role
from app.repositories.cases import CaseRepository, SourceDocumentRepository
from app.services.timeline import build_timeline

router = APIRouter(prefix="/cases", tags=["cases"])


class CaseIn(BaseModel):
    case_code: str = Field(max_length=32)
    title: str = Field(max_length=300)
    summary: str | None = None


class CaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    case_code: str
    title: str
    summary: str | None
    status: str
    is_synthetic: bool
    created_at: datetime


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    filename: str
    mime_type: str
    page_count: int | None
    status: str
    error: str | None


def _get_case_or_404(repo: CaseRepository, case_id: uuid.UUID):
    case = repo.get(case_id)
    if case is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found")
    return case


@router.get("", response_model=list[CaseOut])
def list_cases(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return CaseRepository(db, user.org_id).list()


@router.post("", response_model=CaseOut, status_code=status.HTTP_201_CREATED)
def create_case(
    body: CaseIn,
    user: CurrentUser = Depends(require_role(Role.FACULTY, Role.ADMIN)),
    db: Session = Depends(get_db),
):
    case = CaseRepository(db, user.org_id).add(**body.model_dump(), created_by_user_id=user.id)
    db.commit()
    return case


@router.get("/{case_id}", response_model=CaseOut)
def get_case(case_id: uuid.UUID, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return _get_case_or_404(CaseRepository(db, user.org_id), case_id)


@router.get("/{case_id}/documents", response_model=list[DocumentOut])
def list_case_documents(
    case_id: uuid.UUID, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)
):
    _get_case_or_404(CaseRepository(db, user.org_id), case_id)
    return SourceDocumentRepository(db, user.org_id).for_case(case_id)


MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@router.post("/{case_id}/documents", response_model=DocumentOut, status_code=status.HTTP_202_ACCEPTED)
def upload_document(
    case_id: uuid.UUID,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(require_role(Role.FACULTY, Role.ADMIN)),
    db: Session = Depends(get_db),
):
    """Upload a synthetic case PDF; OCR -> extraction -> derivation runs in the worker."""
    from app.pipeline.tasks import enqueue_document  # keeps celery import out of app startup

    _get_case_or_404(CaseRepository(db, user.org_id), case_id)
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "PDF too large")
    if not data.startswith(b"%PDF"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Only PDF uploads are supported")
    doc_id = uuid.uuid4()
    key = f"{user.org_id}/{case_id}/{doc_id}.pdf"
    storage.write_bytes(key, data)
    doc = SourceDocumentRepository(db, user.org_id).add(
        id=doc_id, case_id=case_id, filename=(file.filename or "upload.pdf")[:300], mime_type="application/pdf",
        storage_key=key, uploaded_by_user_id=user.id,
    )
    db.commit()
    enqueue_document(user.org_id, doc.id, case_id)
    return doc


@router.get("/{case_id}/timeline")
def get_timeline(
    case_id: uuid.UUID, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)
) -> dict[str, Any]:
    """Events in date order (undated under "Date unclear"), with source page links,
    pending tests, discrepancies, and lab change flags. Locked for residents until they submit."""
    _get_case_or_404(CaseRepository(db, user.org_id), case_id)
    ensure_case_unlocked(db, user, case_id)
    return build_timeline(db, user.org_id, case_id)
