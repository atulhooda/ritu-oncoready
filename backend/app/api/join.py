"""Public patient sign-up and sign-in at a clinic (/join/<code>). See app/auth/signup.py."""

import uuid
from datetime import date
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy.orm import Session

from app.auth import signup, sms, whatsapp
from app.auth.security import create_access_token
from app.config import get_settings
from app.db import get_db
from app.models import Org, Role
from app.models.patient import LANGUAGES, SEXES
from app.repositories.orgs import OrgRepository
from app.repositories.users import UserRepository

router = APIRouter(prefix="/join", tags=["patient sign-up"])


class PhoneIn(BaseModel):
    phone: str = Field(min_length=6, max_length=24)


class VerifyIn(PhoneIn):
    code: str = Field(min_length=4, max_length=8)


class StatusIn(PhoneIn):
    challenge_id: uuid.UUID


class RegisterIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    signup_token: str = Field(min_length=10, max_length=2000)
    full_name: str = Field(min_length=2, max_length=200)
    email: EmailStr | None = None
    date_of_birth: date
    sex: Literal[*SEXES]
    preferred_language: Literal[*LANGUAGES] = "en-IN"
    accept_test_terms: Literal[True]  # "this is a test service; I will not enter real medical records"

    @field_validator("email", mode="before")
    @classmethod
    def blank_email(cls, v):
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("date_of_birth")
    @classmethod
    def plausible_dob(cls, v: date) -> date:
        if v > date.today() or v.year < 1900:
            raise ValueError("Enter your real date of birth")
        return v


def _clinic(db: Session, code: str) -> Org:
    org = OrgRepository(db).get_by_join_code(code)
    if org is None or not org.patient_signup_open:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clinic not found")
    return org


def _fail(e: signup.SignupError):
    raise HTTPException(e.status, str(e))


def _clinic_out(org: Org) -> dict[str, Any]:
    return {"name": org.name, "code": org.join_code, "sms": "sms" if sms.enabled() else "demo",
            "whatsapp": whatsapp.enabled()}


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


def _signed_in_or_signup(db: Session, org: Org, phone: str) -> dict[str, Any]:
    """After the number is proven: a known patient here is signed in, a new number may sign up."""
    user = UserRepository(db, org.id).get_by_phone(phone)
    if user is not None:
        if not user.is_active or user.role != Role.PATIENT.value:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "This number cannot sign in here")
        return {"access_token": create_access_token(user.id, org.id, user.role)}
    return {"signup_token": signup.signup_token(org, phone)}


@router.post("/{code}/whatsapp")
def start_whatsapp(code: str, body: PhoneIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Free verification: the patient sends the returned message from their own WhatsApp."""
    org = _clinic(db, code)
    if not whatsapp.enabled():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "WhatsApp verification is not set up here")
    try:
        challenge_id, phone, message = signup.start_whatsapp(db, org, body.phone)
    except signup.SignupError as e:
        db.commit()
        _fail(e)
    db.commit()
    return {"challenge_id": challenge_id, "message": message, "link": whatsapp.link(message),
            "to": get_settings().whatsapp_number, "from": signup.masked_phone(phone)}


@router.post("/{code}/whatsapp/status")
def whatsapp_status(code: str, body: StatusIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Polled by the page: {"waiting": true} until the message arrives, then as /verify."""
    org = _clinic(db, code)
    try:
        phone = signup.whatsapp_status(db, org, body.challenge_id, body.phone)
    except signup.SignupError as e:
        _fail(e)
    if phone is None:
        return {"waiting": True}
    db.commit()
    return _signed_in_or_signup(db, org, phone)


@router.post("/{code}/otp")
def request_code(code: str, body: PhoneIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    org = _clinic(db, code)
    try:
        phone, demo_code = signup.request_otp(db, org, body.phone)
    except signup.SignupError as e:
        db.commit()  # keep the count of codes sent, for rate limiting
        _fail(e)
    db.commit()
    # demo_code only when no SMS provider is configured (test accounts; the page labels it)
    return {"sent_to": signup.masked_phone(phone), "demo_code": demo_code}


@router.post("/{code}/verify")
def verify_code(code: str, body: VerifyIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Existing patient at this clinic: signed in. New number: a short-lived token to finish sign-up."""
    org = _clinic(db, code)
    try:
        phone = signup.verify_otp(db, org, body.phone, body.code)
    except signup.SignupError as e:
        db.commit()  # keep the failed-attempt count
        _fail(e)
    db.commit()
    return _signed_in_or_signup(db, org, phone)


@router.post("/{code}/register", status_code=status.HTTP_201_CREATED)
def register(code: str, body: RegisterIn, db: Session = Depends(get_db)) -> dict[str, Any]:
    org = _clinic(db, code)
    try:
        phone = signup.read_signup_token(body.signup_token, org)
        user = signup.register(db, org, phone, body.full_name, email=body.email, details={
            "date_of_birth": body.date_of_birth, "sex": body.sex, "preferred_language": body.preferred_language,
        })
    except signup.SignupError as e:
        _fail(e)
    db.commit()
    return {"access_token": create_access_token(user.id, org.id, user.role), "patient_number": user.patient_number}
