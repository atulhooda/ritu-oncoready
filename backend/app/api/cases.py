import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser, get_current_user, require_role
from app.db import get_db
from app.models import Role
from app.repositories.cases import CaseRepository, SourceDocumentRepository

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
