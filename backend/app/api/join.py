"""Public patient sign-up and log-in at a clinic. See app/auth/signup.py.

GET  /join                     the default clinic (the main page)
GET  /join/{code}              a clinic by its code
POST /join/{code}/phone/send   send a 6-digit code to the phone's WhatsApp
POST /join/{code}/phone/verify check it -> phone_token for the sign-up form
POST /join/{code}/signup       create the patient account -> access token
POST /join/{code}/login        email + password -> access token
"""

from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy.orm import Session

from app.auth import signup
from app.auth.security import create_access_token
from app.config import get_settings
from app.db import get_db
from app.models import Org
from app.models.patient import LANGUAGES, SEXES
from app.repositories.orgs import OrgRepository

router = APIRouter(prefix="/join", tags=["patient sign-up"])

MIN_PASSWORD = 8


class PhoneIn(BaseModel):
    phone: str = Field(min_length=6, max_length=24)


class VerifyIn(PhoneIn):
    code: str = Field(min_length=4, max_length=8)


class SignupIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    full_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    phone: str = Field(min_length=6, max_length=24)
    phone_token: str | None = Field(None, max_length=2000)  # required when the phone check is set up
    password: str = Field(min_length=MIN_PASSWORD, max_length=200)
    date_of_birth: date
    sex: Literal[*SEXES]
    preferred_language: Literal[*LANGUAGES] = "en-IN"
    accept_test_terms: Literal[True]  # "this is a pilot; I will not enter real medical records"

    @field_validator("date_of_birth")
    @classmethod
    def plausible_dob(cls, v: date) -> date:
        if v > date.today() or v.year < 1900:
            raise ValueError("Enter your real date of birth")
        return v


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=200)


def _clinic(db: Session, code: str) -> Org:
    org = OrgRepository(db).get_by_join_code(code)
    if org is None or not org.patient_signup_open:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clinic not found")
    return org


def _fail(e: signup.SignupError):
    raise HTTPException(e.status, str(e))


def _clinic_out(org: Org) -> dict[str, Any]:
    return {"name": org.name, "code": org.join_code, "phone_check": signup.phone_check_available()}


@router.get("")
def default_clinic(db: Session = Depends(get_db)) -> dict[str, Any]:
    """The clinic the main page signs patients up to: DEFAULT_CLINIC_CODE, else the only open one."""
    code = get_settings().default_clinic_code
    if code:
        return _clinic_out(_clinic(db, code))
    open_clinics = OrgRepository(db).open_for_signup()
    if len(open_clinics) != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Use your clinic's sign-up link")
    return _clinic_out(open_clinics[0])


@router.get("/{code}")
def clinic(code: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    return _clinic_out(_clinic(db, code))


@router.post("/{code}/phone/send")
def send_phone_code(code: str, body: PhoneIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    org = _clinic(db, code)
    try:
        phone = signup.send_phone_code(db, org, body.phone)
    except signup.SignupError as e:
        db.commit()  # keep the count of codes sent, for rate limiting
        _fail(e)
    db.commit()
    return {"sent_to": signup.masked_phone(phone)}


@router.post("/{code}/phone/verify")
def verify_phone_code(code: str, body: VerifyIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    org = _clinic(db, code)
    try:
        phone = signup.verify_phone_code(db, org, body.phone, body.code)
    except signup.SignupError as e:
        db.commit()  # keep the failed-attempt count
        _fail(e)
    db.commit()
    return {"phone_token": signup.phone_token(org, phone)}


@router.post("/{code}/signup", status_code=status.HTTP_201_CREATED)
def sign_up(code: str, body: SignupIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    org = _clinic(db, code)
    try:
        phone = signup.normalize_phone(body.phone)
        verified = False
        if signup.phone_check_available():
            if not body.phone_token:
                raise signup.SignupError("Verify your phone number first.", 422)
            if signup.read_phone_token(body.phone_token, org) != phone:
                raise signup.SignupError("Verify this phone number first.", 422)
            verified = True
        user = signup.sign_up(db, org, full_name=body.full_name, email=str(body.email), password=body.password,
                              phone=phone, phone_verified=verified, details={
                                  "date_of_birth": body.date_of_birth, "sex": body.sex,
                                  "preferred_language": body.preferred_language})
    except signup.SignupError as e:
        _fail(e)
    db.commit()
    return {"access_token": create_access_token(user.id, org.id, user.role), "patient_number": user.patient_number}


@router.post("/{code}/login")
def log_in(code: str, body: LoginIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    org = _clinic(db, code)
    try:
        user = signup.log_in(db, org, body.email, body.password)
    except signup.SignupError as e:
        _fail(e)
    return {"access_token": create_access_token(user.id, org.id, user.role)}
