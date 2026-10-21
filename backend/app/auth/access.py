"""Who may see which case, beyond org scoping (which repositories already enforce).

- training cases: residents, faculty, admins
- intake cases: the owning patient, and doctors once the patient has sent (published) it
Anything else is reported as 404.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser
from app.models import PatientCase, Role
from app.repositories.cases import CaseRepository

TRAINING_ROLES = (Role.RESIDENT, Role.FACULTY, Role.ADMIN)


def can_view(user: CurrentUser, case: PatientCase) -> bool:
    if case.kind == "training":
        return user.role in TRAINING_ROLES
    if user.role == Role.PATIENT:
        return case.patient_user_id == user.id
    if user.role == Role.DOCTOR:
        return case.published_at is not None
    return False


def visible_case_or_404(db: Session, user: CurrentUser, case_id: uuid.UUID) -> PatientCase:
    case = CaseRepository(db, user.org_id).get(case_id)
    if case is None or not can_view(user, case):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found")
    return case


def visible_cases(db: Session, user: CurrentUser) -> list[PatientCase]:
    cases = CaseRepository(db, user.org_id)
    if user.role in TRAINING_ROLES:
        return list(cases.training())
    if user.role == Role.DOCTOR:
        return list(cases.published_intake())
    own = cases.for_patient(user.id) if user.role == Role.PATIENT else None
    return [own] if own else []
