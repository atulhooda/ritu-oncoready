import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser, require_role
from app.db import get_db
from app.models import ReadinessBrief, Role
from app.repositories.cases import CaseRepository
from app.repositories.scoring import BriefItemMatchRepository, ReadinessBriefRepository, ScoreRepository
from app.repositories.users import UserRepository
from app.scoring.engine import ENGINE_VERSION
from app.scoring.matching import SECTIONS
from app.scoring.service import OverrideError, clear_override, set_override

router = APIRouter(prefix="/faculty", tags=["faculty"])
faculty_only = require_role(Role.FACULTY, Role.ADMIN)


class OverrideIn(BaseModel):
    matched: bool
    comment: str = Field(min_length=1, max_length=2000)
    evidence_quote: str | None = Field(None, max_length=2000)


def _brief_or_404(db: Session, org_id: uuid.UUID, brief_id: uuid.UUID) -> ReadinessBrief:
    brief = ReadinessBriefRepository(db, org_id).get(brief_id)
    if brief is None or brief.status == "draft":  # drafts are private to the resident
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Brief not found")
    return brief


def _current_score(db: Session, org_id: uuid.UUID, brief_id: uuid.UUID):
    scores = [s for s in ScoreRepository(db, org_id).for_brief(brief_id) if s.scoring_version == ENGINE_VERSION]
    return max(scores, key=lambda s: s.created_at, default=None)


def _summary(db: Session, org_id: uuid.UUID, brief: ReadinessBrief, names: dict, cases: dict) -> dict[str, Any]:
    s = _current_score(db, org_id, brief.id)
    case = cases.get(brief.case_id)
    return {
        "id": brief.id, "case_id": brief.case_id,
        "case_code": case.case_code if case else None, "case_title": case.title if case else None,
        "resident_id": brief.author_user_id, "resident_name": names.get(brief.author_user_id),
        "status": brief.status, "submitted_at": brief.submitted_at, "scoring_error": brief.scoring_error,
        "score": None if s is None else {
            "points_earned": str(s.points_earned), "points_possible": str(s.points_possible),
            "percent": s.details.get("percent"), "critical_missed": s.critical_missed,
            "engine_version": s.scoring_version,
        },
    }


def _lookups(db: Session, org_id: uuid.UUID) -> tuple[dict, dict]:
    names = {u.id: u.full_name for u in UserRepository(db, org_id).list(limit=1000)}
    cases = {c.id: c for c in CaseRepository(db, org_id).list(limit=1000)}
    return names, cases


@router.get("/briefs")
def list_briefs(
    resident_id: uuid.UUID | None = None,
    user: CurrentUser = Depends(faculty_only), db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    names, cases = _lookups(db, user.org_id)
    return [_summary(db, user.org_id, b, names, cases)
            for b in ReadinessBriefRepository(db, user.org_id).submitted(resident_id)]


def _detail(db: Session, org_id: uuid.UUID, brief: ReadinessBrief) -> dict[str, Any]:
    names, cases = _lookups(db, org_id)
    s = _current_score(db, org_id, brief.id)
    matches = {str(m.rubric_item_id): m for m in BriefItemMatchRepository(db, org_id).for_brief(brief.id)}
    items = []
    for row in (s.details["items"] if s else []):
        m = matches.get(row["rubric_item_id"])
        items.append({
            **row,
            "rejected_evidence": m.rejected_evidence if m else [],
            "overridden_by": names.get(m.overridden_by_user_id) if m and m.overridden_by_user_id else None,
            "overridden_at": m.overridden_at if m else None,
        })
    return {
        **_summary(db, org_id, brief, names, cases),
        "sections": {k: brief.content.get(k, "") for k in SECTIONS},
        "section_labels": SECTIONS,
        "items": items,
        "by_category": s.details["by_category"] if s else {},
    }


@router.get("/briefs/{brief_id}")
def get_brief(brief_id: uuid.UUID, user: CurrentUser = Depends(faculty_only), db: Session = Depends(get_db)):
    return _detail(db, user.org_id, _brief_or_404(db, user.org_id, brief_id))


@router.put("/briefs/{brief_id}/items/{rubric_item_id}/override")
def override_item(
    brief_id: uuid.UUID, rubric_item_id: uuid.UUID, body: OverrideIn,
    user: CurrentUser = Depends(faculty_only), db: Session = Depends(get_db),
):
    brief = _brief_or_404(db, user.org_id, brief_id)
    try:
        set_override(db, user.org_id, brief.id, rubric_item_id, body.matched, body.comment, user.id, body.evidence_quote)
    except LookupError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))
    except OverrideError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    db.commit()
    return _detail(db, user.org_id, brief)


@router.delete("/briefs/{brief_id}/items/{rubric_item_id}/override")
def remove_override(
    brief_id: uuid.UUID, rubric_item_id: uuid.UUID,
    user: CurrentUser = Depends(faculty_only), db: Session = Depends(get_db),
):
    brief = _brief_or_404(db, user.org_id, brief_id)
    try:
        clear_override(db, user.org_id, brief.id, rubric_item_id)
    except LookupError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e))
    db.commit()
    return _detail(db, user.org_id, brief)


@router.get("/residents")
def list_residents(user: CurrentUser = Depends(faculty_only), db: Session = Depends(get_db)) -> list[dict]:
    users = UserRepository(db, user.org_id)
    residents = users.list(users.model.role == Role.RESIDENT.value, limit=1000)
    out = []
    for r in residents:
        briefs = ReadinessBriefRepository(db, user.org_id).submitted(r.id)
        pct = [float(s.details["percent"]) for b in briefs if (s := _current_score(db, user.org_id, b.id))]
        out.append({"id": r.id, "name": r.full_name, "email": r.email, "briefs": len(briefs),
                    "mean_percent": round(sum(pct) / len(pct), 1) if pct else None})
    return out


@router.get("/residents/{resident_id}/trend")
def resident_trend(
    resident_id: uuid.UUID, user: CurrentUser = Depends(faculty_only), db: Session = Depends(get_db)
) -> dict[str, Any]:
    """Scores across cases, and which rubric categories the resident keeps missing."""
    resident = UserRepository(db, user.org_id).get(resident_id)
    if resident is None or resident.role != Role.RESIDENT.value:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Resident not found")
    names, cases = _lookups(db, user.org_id)
    timeline, categories = [], {}
    for b in ReadinessBriefRepository(db, user.org_id).submitted(resident.id):
        s = _current_score(db, user.org_id, b.id)
        timeline.append(_summary(db, user.org_id, b, names, cases))
        if s is None:
            continue
        for cat, v in s.details["by_category"].items():
            c = categories.setdefault(cat, {"category": cat, "items": 0, "missed": 0, "critical_missed": 0,
                                            "cases_with_miss": 0, "cases": 0})
            c["items"] += v["matched"] + v["missed"]
            c["missed"] += v["missed"]
            c["critical_missed"] += v["critical_missed"]
            c["cases"] += 1
            c["cases_with_miss"] += int(v["missed"] > 0)
    for c in categories.values():
        c["miss_rate"] = round(c["missed"] / c["items"], 3) if c["items"] else 0.0
        c["repeatedly_missed"] = c["cases_with_miss"] >= 2
    ranked = sorted(categories.values(), key=lambda c: (-c["miss_rate"], -c["critical_missed"], c["category"]))
    return {"resident": {"id": resident.id, "name": resident.full_name}, "cases": timeline, "categories": ranked}
