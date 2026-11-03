"""The hospital account: adds its doctors (junior or senior), sees every patient who sent their
check-in, and assigns each one to a junior doctor."""

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy.orm import Session

from app.api.doctor import patient_row
from app.auth.access import visible_case_or_404, visible_cases
from app.auth.deps import CurrentUser, require_role
from app.auth.security import hash_password
from app.db import get_db
from app.models import Role
from app.repositories.users import UserRepository
from app.services import review as reviews

router = APIRouter(prefix="/hospital", tags=["hospital"])
hospital_only = require_role(Role.HOSPITAL)

Seniority = Literal["junior", "senior"]


class DoctorIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    seniority: Seniority


class DoctorChange(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    full_name: str | None = Field(None, min_length=2, max_length=120)
    seniority: Seniority | None = None
    is_active: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=128)


def _doctor_out(u) -> dict[str, Any]:
    return {"id": u.id, "name": u.full_name, "email": u.email, "seniority": u.seniority, "active": u.is_active}


@router.get("/doctors")
def list_doctors(current: CurrentUser = Depends(hospital_only), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [_doctor_out(u) for u in UserRepository(db, current.org_id).doctors()]


@router.post("/doctors", status_code=status.HTTP_201_CREATED)
def add_doctor(body: DoctorIn, current: CurrentUser = Depends(hospital_only), db: Session = Depends(get_db)):
    users = UserRepository(db, current.org_id)
    if users.get_by_email(body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "Someone at this hospital already uses that email")
    user = users.create(body.email, body.full_name, body.password, Role.DOCTOR, seniority=body.seniority)
    db.commit()
    return _doctor_out(user)


@router.patch("/doctors/{user_id}")
def change_doctor(
    user_id: uuid.UUID, body: DoctorChange, current: CurrentUser = Depends(hospital_only), db: Session = Depends(get_db)
):
    user = UserRepository(db, current.org_id).get(user_id)
    if user is None or user.role != Role.DOCTOR.value:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Doctor not found")
    if body.full_name is not None:
        user.full_name = body.full_name
    if body.seniority is not None:
        user.seniority = body.seniority
    if body.is_active is not None:
        user.is_active = body.is_active
    if body.password is not None:
        user.password_hash = hash_password(body.password)
    db.commit()
    return _doctor_out(user)


@router.get("/patients")
def list_patients(current: CurrentUser = Depends(hospital_only), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    """Every patient who sent their check-in, newest first, with who has it now."""
    return [patient_row(db, current.org_id, case) for case in visible_cases(db, current)]


class AssignIn(BaseModel):
    junior_user_id: uuid.UUID


@router.post("/patients/{case_id}/assign")
def assign_patient(
    case_id: uuid.UUID, body: AssignIn, current: CurrentUser = Depends(hospital_only), db: Session = Depends(get_db)
):
    case = visible_case_or_404(db, current, case_id)
    try:
        review = reviews.assign(db, current.org_id, case, body.junior_user_id)
    except reviews.ReviewError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e))
    db.commit()
    return reviews.review_out(db, current.org_id, case, review)
