import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser, require_role
from app.db import get_db
from app.models import Role
from app.auth.access import visible_case_or_404
from app.repositories.scoring import ReadinessBriefRepository
from app.scoring import tasks
from app.scoring.matching import SECTIONS

router = APIRouter(prefix="/cases/{case_id}/brief", tags=["briefs"])
resident_only = require_role(Role.RESIDENT)


class BriefSections(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key_changes: str = Field("", max_length=5000)
    pending_investigations: str = Field("", max_length=5000)
    discrepancies_noticed: str = Field("", max_length=5000)
    treatment_history: str = Field("", max_length=5000)
    red_flags: str = Field("", max_length=5000)


class BriefOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    status: str
    submitted_at: datetime | None
    sections: BriefSections
    section_labels: dict[str, str] = SECTIONS


def _case_or_404(db: Session, user: CurrentUser, case_id: uuid.UUID) -> None:
    visible_case_or_404(db, user, case_id)  # residents only ever see training cases


def _out(brief) -> BriefOut:
    return BriefOut(
        id=brief.id, case_id=brief.case_id, status=brief.status, submitted_at=brief.submitted_at,
        sections=BriefSections(**{k: brief.content.get(k, "") for k in SECTIONS}),
    )


@router.get("", response_model=BriefOut)
def get_my_brief(case_id: uuid.UUID, user: CurrentUser = Depends(resident_only), db: Session = Depends(get_db)):
    _case_or_404(db, user, case_id)
    brief = ReadinessBriefRepository(db, user.org_id).get_for(case_id, user.id)
    if brief is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No brief yet")
    return _out(brief)


@router.put("", response_model=BriefOut)
def save_draft(
    case_id: uuid.UUID, body: BriefSections,
    user: CurrentUser = Depends(resident_only), db: Session = Depends(get_db),
):
    _case_or_404(db, user, case_id)
    briefs = ReadinessBriefRepository(db, user.org_id)
    brief = briefs.get_for(case_id, user.id)
    if brief is None:
        brief = briefs.add(case_id=case_id, author_user_id=user.id, content=body.model_dump())
    elif brief.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Brief already submitted")
    else:
        brief.content = body.model_dump()
    db.commit()
    return _out(brief)


@router.post("/submit", response_model=BriefOut)
def submit(case_id: uuid.UUID, user: CurrentUser = Depends(resident_only), db: Session = Depends(get_db)):
    _case_or_404(db, user, case_id)
    brief = ReadinessBriefRepository(db, user.org_id).get_for(case_id, user.id)
    if brief is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No brief yet")
    if brief.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Brief already submitted")
    if not any((brief.content.get(k) or "").strip() for k in SECTIONS):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Brief is empty")
    brief.status = "submitted"
    brief.submitted_at = datetime.now(UTC)
    db.commit()
    tasks.enqueue_scoring(user.org_id, brief.id)
    return _out(brief)
