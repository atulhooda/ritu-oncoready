"""Who may see which case, beyond org scoping (which repositories already enforce).

- training cases: residents, faculty, admins
- intake cases: the owning patient; once the patient has sent (published) it, the hospital account,
  the junior doctor it is assigned to, and the senior doctor the junior sent it to
Anything else is reported as 404.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser
from app.models import CaseReview, PatientCase, Role
from app.repositories.cases import CaseRepository
from app.repositories.reviews import CaseReviewRepository

TRAINING_ROLES = (Role.RESIDENT, Role.FACULTY, Role.ADMIN)


def doctor_can_see(user: CurrentUser, review: CaseReview | None) -> bool:
    if review is None:
        return False
    as_junior = review.junior_user_id == user.id and review.status in ("with_junior", "with_senior")
    as_senior = review.senior_user_id == user.id and review.status == "with_senior"
    return as_junior or as_senior


def can_view(user: CurrentUser, case: PatientCase, review: CaseReview | None = None) -> bool:
    if case.kind == "training":
        return user.role in TRAINING_ROLES
    if user.role == Role.PATIENT:
        return case.patient_user_id == user.id
    if case.published_at is None:
        return False
    if user.role == Role.HOSPITAL:
        return True
    if user.role == Role.DOCTOR:
        return doctor_can_see(user, review)
    return False


def visible_case_or_404(db: Session, user: CurrentUser, case_id: uuid.UUID) -> PatientCase:
    case = CaseRepository(db, user.org_id).get(case_id)
    review = CaseReviewRepository(db, user.org_id).for_case(case_id) if user.role == Role.DOCTOR else None
    if case is None or not can_view(user, case, review):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found")
    return case


def visible_cases(db: Session, user: CurrentUser) -> list[PatientCase]:
    cases = CaseRepository(db, user.org_id)
    if user.role in TRAINING_ROLES:
        return list(cases.training())
    if user.role == Role.HOSPITAL:
        return list(cases.published_intake())
    if user.role == Role.DOCTOR:
        reviews = CaseReviewRepository(db, user.org_id)
        mine = {r.case_id for r in [*reviews.for_junior(user.id), *reviews.for_senior(user.id)] if doctor_can_see(user, r)}
        return [c for c in cases.published_intake() if c.id in mine]
    own = cases.for_patient(user.id) if user.role == Role.PATIENT else None
    return [own] if own else []
