"""A sent patient's path through the hospital: the hospital assigns a junior doctor, the junior edits
a summary and sends it to a senior doctor (`CaseReview`).

The first draft of the summary is built in code from what the patient reported (their details and
their own words from the latest pre-visit conversation). No interpretation is added; the junior
doctor writes anything more.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.intake import service
from app.models import CaseReview, PatientCase, Role, User
from app.repositories.reviews import CaseReviewRepository
from app.repositories.users import UserRepository

TREATMENT_STATUS = {
    "not_started": "not started yet", "on_treatment": "on treatment now", "completed": "finished treatment",
    "follow_up": "in follow-up", "not_sure": "not sure",
}


class ReviewError(ValueError):
    pass


def draft_summary(db: Session, org_id: uuid.UUID, case: PatientCase) -> str:
    d = service.patient_details(db, org_id, case.patient_user_id)
    who = [case.title]
    if d["age"] is not None:
        who.append(f"{d['age']} y")
    if d["sex"]:
        who.append(d["sex"].replace("_", " "))
    lines = [", ".join(who)]
    reported = [
        ("Cancer (as told by the patient)", d["cancer_type"]),
        ("Stage (as told by the patient)", d["stage_reported"]),
        ("Diagnosed", d["diagnosed_on"] and str(d["diagnosed_on"])),
        ("Treatment", TREATMENT_STATUS.get(d["treatment_status"] or "")),
        ("Current treatment", d["current_treatment"]),
        ("Other conditions", d["other_conditions"]),
    ]
    lines += [f"{label}: {value}" for label, value in reported if value]
    summary = service.build_summary(db, org_id, case.id)
    for section in summary["sections"] if summary else []:
        if not section["facts"]:
            continue
        lines += ["", f"{section['label']}:"]
        for f in section["facts"]:
            extra = ", ".join(f"{k}: {v}" for k, v in f["details"].items() if v)
            lines.append(f"- {f['label']}{f' ({extra})' if extra else ''}{' [urgent sign]' if f['urgent'] else ''}"
                         f' - "{f["quote"]}"')
    records = service.records(db, org_id, case.id)
    if records:
        lines += ["", f"Records uploaded: {len(records)}"]
    lines += ["", "Junior doctor's notes:", ""]
    return "\n".join(lines)


def doctor_name(db: Session, org_id: uuid.UUID, user_id: uuid.UUID | None) -> dict[str, Any] | None:
    user = UserRepository(db, org_id).get(user_id) if user_id else None
    return {"id": user.id, "name": user.full_name} if user else None


def review_out(db: Session, org_id: uuid.UUID, case: PatientCase, review: CaseReview | None) -> dict[str, Any]:
    if review is None:
        return {"status": "unassigned", "summary": None, "junior": None, "senior": None,
                "assigned_at": None, "summary_updated_at": None, "sent_at": None}
    return {
        "status": review.status,
        "summary": review.summary if review.summary is not None else (
            draft_summary(db, org_id, case) if review.status != "unassigned" else None),
        "summary_is_draft": review.summary is None,
        "junior": doctor_name(db, org_id, review.junior_user_id),
        "senior": doctor_name(db, org_id, review.senior_user_id),
        "assigned_at": review.assigned_at,
        "summary_updated_at": review.summary_updated_at,
        "sent_at": review.sent_at,
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


def _editable_by(review: CaseReview | None, user_id: uuid.UUID) -> CaseReview:
    if review is None or review.junior_user_id != user_id or review.status != "with_junior":
        raise ReviewError("only the junior doctor this patient is assigned to can change the summary, before sending it")
    return review


def save_summary(db: Session, org_id: uuid.UUID, case: PatientCase, user_id: uuid.UUID, text: str) -> CaseReview:
    review = _editable_by(CaseReviewRepository(db, org_id).for_case(case.id), user_id)
    review.summary, review.summary_updated_by, review.summary_updated_at = text, user_id, datetime.now(UTC)
    db.flush()
    return review


def send_to_senior(
    db: Session, org_id: uuid.UUID, case: PatientCase, user_id: uuid.UUID, senior_user_id: uuid.UUID, text: str
) -> CaseReview:
    review = _editable_by(CaseReviewRepository(db, org_id).for_case(case.id), user_id)
    _active_doctor(db, org_id, senior_user_id, "senior")
    now = datetime.now(UTC)
    review.summary, review.summary_updated_by, review.summary_updated_at = text, user_id, now
    review.senior_user_id, review.status, review.sent_at = senior_user_id, "with_senior", now
    db.flush()
    return review
