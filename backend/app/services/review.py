"""A sent patient's path through the hospital: it goes to a junior doctor automatically, the junior
prepares a summary and sends it to a senior doctor (`CaseReview`).

The summary is structured (`CaseReview.content`): which points the patient reported the senior
should see (intake fact ids, shown with the patient's own words) and the junior's own points
(a concern, a finding, or a question for the senior; optionally with where it came from). The first
draft ticks the current symptoms, the patient's questions and anything on the urgent-signs list;
nothing is written for the junior. The plain-text copy (`CaseReview.summary`) is built in code.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.intake import service
from app.models import CaseReview, PatientCase, Role, User
from app.repositories.cases import CaseRepository
from app.repositories.reviews import CaseReviewRepository
from app.repositories.users import UserRepository

# The junior's own points, each of one kind, shown to the senior grouped in this order.
POINT_KINDS = {
    "concern": "Concerns",
    "finding": "From the records and conversation",
    "question": "For the senior doctor",
}
OLD_NOTES = {"findings": "finding", "concerns": "concern", "questions": "question"}  # before points
DRAFT_SECTIONS = ("current_symptom", "concern")
MAX_POINT = 2000
MAX_POINTS = 100


class ReviewError(ValueError):
    pass


def reported_facts(db: Session, org_id: uuid.UUID, case: PatientCase) -> list[dict[str, Any]]:
    """Every point from the latest pre-visit conversation, in report order, with its section."""
    summary = service.build_summary(db, org_id, case.id)
    return [{**f, "section": sec["section"], "section_label": sec["label"]}
            for sec in (summary["sections"] if summary else []) for f in sec["facts"]]


def draft_content(facts: list[dict[str, Any]]) -> dict[str, Any]:
    return {"facts": [str(f["id"]) for f in facts if f["section"] in DRAFT_SECTIONS or f["urgent"]], "points": []}


def with_points(content: dict[str, Any]) -> dict[str, Any]:
    """Content saved before points existed (three note boxes) as points."""
    if "points" in content:
        return content
    points = [{"kind": kind, "text": content[old], "source": None} for old, kind in OLD_NOTES.items() if content.get(old)]
    return {"facts": content.get("facts", []), "points": points}


def clean_content(facts: list[dict[str, Any]], content: dict[str, Any]) -> dict[str, Any]:
    known = {str(f["id"]) for f in facts}
    chosen = [str(i) for i in content.get("facts", [])]
    if any(i not in known for i in chosen):
        raise ReviewError("a ticked point is not in this patient's report")
    points = []
    for p in content.get("points", [])[:MAX_POINTS]:
        text = (p.get("text") or "").strip()[:MAX_POINT]
        if text and p.get("kind") in POINT_KINDS:
            points.append({"kind": p["kind"], "text": text, "source": (p.get("source") or "").strip()[:300] or None})
    out = {"facts": [str(f["id"]) for f in facts if str(f["id"]) in chosen], "points": points}  # facts in report order
    if not out["facts"] and not points:
        raise ReviewError("the summary is empty: tick a point or add one")
    return out


def summary_text(case: PatientCase, details: dict[str, Any], facts: list[dict[str, Any]], content: dict[str, Any]) -> str:
    """Plain-text copy of the structured summary."""
    who = [case.title, f"{details['age']} y" if details["age"] is not None else None,
           (details["sex"] or "").replace("_", " ") or None, details["cancer_type"]]
    lines = [" · ".join(w for w in who if w)]
    by_id = {str(f["id"]): f for f in facts}
    chosen = [by_id[i] for i in content["facts"] if i in by_id]
    section = None
    for f in chosen:
        if f["section_label"] != section:
            section = f["section_label"]
            lines += ["", f"{section}:"]
        extra = ", ".join(f"{k}: {v}" for k, v in f["details"].items() if v)
        lines.append(f"- {f['label']}{f' ({extra})' if extra else ''}{' [urgent sign]' if f['urgent'] else ''}")
    for kind, label in POINT_KINDS.items():
        mine = [p for p in content["points"] if p["kind"] == kind]
        if mine:
            lines += ["", f"{label}:"] + [f"- {p['text']}{f' ({p['source']})' if p['source'] else ''}" for p in mine]
    return "\n".join(lines)


def doctor_name(db: Session, org_id: uuid.UUID, user_id: uuid.UUID | None) -> dict[str, Any] | None:
    user = UserRepository(db, org_id).get(user_id) if user_id else None
    return {"id": user.id, "name": user.full_name} if user else None


def review_out(db: Session, org_id: uuid.UUID, case: PatientCase, review: CaseReview | None) -> dict[str, Any]:
    if review is None or review.status == "unassigned":
        content = None
    elif review.content is not None:
        content = with_points(review.content)
    else:
        content = draft_content(reported_facts(db, org_id, case))
        if review.summary:  # written before summaries were structured
            content["points"] = [{"kind": "finding", "text": review.summary, "source": None}]
    return {
        "status": review.status if review else "unassigned",
        "content": content,
        "summary_is_draft": review is None or review.content is None,
        "summary": review.summary if review else None,
        "junior": doctor_name(db, org_id, review.junior_user_id) if review else None,
        "senior": doctor_name(db, org_id, review.senior_user_id) if review else None,
        "assigned_at": review.assigned_at if review else None,
        "summary_updated_at": review.summary_updated_at if review else None,
        "sent_at": review.sent_at if review else None,
    }


def _active_doctor(db: Session, org_id: uuid.UUID, user_id: uuid.UUID, seniority: str) -> User:
    user = UserRepository(db, org_id).get(user_id)
    if user is None or user.role != Role.DOCTOR.value or user.seniority != seniority or not user.is_active:
        raise ReviewError(f"choose an active {seniority} doctor")
    return user


def assign(db: Session, org_id: uuid.UUID, case: PatientCase, junior_user_id: uuid.UUID) -> CaseReview:
    review = CaseReviewRepository(db, org_id).ensure(case.id)
    if review.status == "with_senior":
        raise ReviewError("the summary has already been sent to a senior doctor")
    _active_doctor(db, org_id, junior_user_id, "junior")
    review.junior_user_id, review.status, review.assigned_at = junior_user_id, "with_junior", datetime.now(UTC)
    db.flush()
    return review


def assign_waiting(db: Session, org_id: uuid.UUID) -> int:
    """Give every sent patient without a junior to an active junior doctor: each one to whoever has
    the fewest patients still with them (then by name). Runs when a patient sends their check-in and
    whenever the hospital changes its doctors. Returns how many were assigned."""
    repo = CaseReviewRepository(db, org_id)
    for case in CaseRepository(db, org_id).published_intake():  # sent before reviews existed
        repo.ensure(case.id)
    db.flush()
    juniors = [d for d in UserRepository(db, org_id).doctors() if d.seniority == "junior" and d.is_active]
    if not juniors:
        return 0
    load = {j.id: sum(r.status == "with_junior" for r in repo.for_junior(j.id)) for j in juniors}
    waiting = repo.waiting()
    for review in waiting:
        junior = min(juniors, key=lambda j: (load[j.id], j.full_name))
        review.junior_user_id, review.status, review.assigned_at = junior.id, "with_junior", datetime.now(UTC)
        load[junior.id] += 1
    db.flush()
    return len(waiting)


def release(db: Session, org_id: uuid.UUID, doctor_id: uuid.UUID) -> None:
    """A junior who left (deactivated, or now senior): their unsent patients go back to waiting."""
    for review in CaseReviewRepository(db, org_id).for_junior(doctor_id):
        if review.status == "with_junior":
            review.junior_user_id, review.status, review.assigned_at = None, "unassigned", None
    db.flush()


def open_patients(db: Session, org_id: uuid.UUID, doctor: User) -> int:
    """Patients waiting on this doctor: a junior's unsent ones, a senior's received ones."""
    repo = CaseReviewRepository(db, org_id)
    if doctor.seniority == "junior":
        return sum(r.status == "with_junior" for r in repo.for_junior(doctor.id))
    return len(repo.for_senior(doctor.id))


def _editable_by(review: CaseReview | None, user_id: uuid.UUID) -> CaseReview:
    if review is None or review.junior_user_id != user_id or review.status != "with_junior":
        raise ReviewError("only the junior doctor this patient is assigned to can change the summary, before sending it")
    return review


def _write(db: Session, org_id: uuid.UUID, case: PatientCase, review: CaseReview, user_id: uuid.UUID, content: dict[str, Any]) -> None:
    facts = reported_facts(db, org_id, case)
    review.content = clean_content(facts, content)
    review.summary = summary_text(case, service.patient_details(db, org_id, case.patient_user_id), facts, review.content)
    review.summary_updated_by, review.summary_updated_at = user_id, datetime.now(UTC)


def save_summary(db: Session, org_id: uuid.UUID, case: PatientCase, user_id: uuid.UUID, content: dict[str, Any]) -> CaseReview:
    review = _editable_by(CaseReviewRepository(db, org_id).for_case(case.id), user_id)
    _write(db, org_id, case, review, user_id, content)
    db.flush()
    return review


def send_to_senior(
    db: Session, org_id: uuid.UUID, case: PatientCase, user_id: uuid.UUID, senior_user_id: uuid.UUID,
    content: dict[str, Any],
) -> CaseReview:
    review = _editable_by(CaseReviewRepository(db, org_id).for_case(case.id), user_id)
    _active_doctor(db, org_id, senior_user_id, "senior")
    _write(db, org_id, case, review, user_id, content)
    review.senior_user_id, review.status, review.sent_at = senior_user_id, "with_senior", review.summary_updated_at
    db.flush()
    return review
