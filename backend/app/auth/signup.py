"""Patient accounts at a clinic. Rules: BEHAVIOR_SPEC.md "Patient sign-up".

  sign up:  name, email, phone, password, date of birth, sex, language, where they live
            phone proven by a 6-digit code sent to the patient's WhatsApp (when WhatsApp is set up;
            otherwise the phone is saved unverified)
  log in:   email + password
"""

import hashlib
import hmac
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import whatsapp
from app.auth.security import hash_password, verify_password
from app.config import get_settings
from app.models import Org, Role, User
from app.repositories.users import PhoneOtpRepository, UserRepository

PHONE_TOKEN_MINUTES = 30
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # no I, L, O, U: easy to read out over the phone


class SignupError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def normalize_phone(raw: str) -> str:
    """'98123 45678' / '+91 98123-45678' / '0919812345678' -> '+919812345678'."""
    digits = re.sub(r"[\s\-()]", "", raw or "")
    if digits.startswith("+") and not digits.startswith("+91"):  # another country
        if re.fullmatch(r"\+[1-9]\d{7,14}", digits):
            return digits
    elif re.fullmatch(r"(\+91|0091|91|0)?[6-9]\d{9}", digits):  # India: mobiles start with 6-9
        return "+91" + digits[-10:]
    raise SignupError("Enter a valid mobile number", 422)


def masked_phone(phone: str) -> str:
    return phone[:3] + " " + "•" * (len(phone) - 7) + phone[-4:]


def new_patient_number() -> str:
    raw = "".join(secrets.choice(CROCKFORD) for _ in range(8))
    return f"OR-{raw[:4]}-{raw[4:]}"


def _code_hash(org_id: uuid.UUID, phone: str, code: str) -> str:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, f"{org_id}:{phone}:{code}".encode(), hashlib.sha256).hexdigest()


# ─── phone check: a code sent to WhatsApp ──────────────────────────────────────────────────

def phone_check_available() -> bool:
    return whatsapp.enabled()


def send_phone_code(db: Session, org: Org, raw_phone: str) -> str:
    """Send a 6-digit code to the phone's WhatsApp. Rate limited per phone and clinic."""
    if not phone_check_available():
        raise SignupError("Phone check is not set up here yet", 409)
    s = get_settings()
    phone = normalize_phone(raw_phone)
    otps = PhoneOtpRepository(db, org.id)
    now = datetime.now(UTC)
    if otps.sent_since(phone, now - timedelta(hours=1)) >= s.otp_max_per_hour:
        raise SignupError("Too many codes for this number. Try again in an hour.", 429)
    code = f"{secrets.randbelow(10**6):06d}"
    otps.add(phone=phone, channel="whatsapp", code_hash=_code_hash(org.id, phone, code),
             expires_at=now + timedelta(seconds=s.otp_ttl_seconds))
    db.flush()
    try:
        whatsapp.send_code(phone, code)
    except whatsapp.WhatsAppError as e:
        raise SignupError(str(e), 502) from e
    return phone


def verify_phone_code(db: Session, org: Org, raw_phone: str, code: str) -> str:
    """Checks the newest code sent to this phone at this clinic. Returns the phone on success."""
    s = get_settings()
    phone = normalize_phone(raw_phone)
    otp = PhoneOtpRepository(db, org.id).latest_open(phone, channel="whatsapp")
    now = datetime.now(UTC)
    if otp is None or otp.expires_at <= now:
        raise SignupError("The code has expired. Ask for a new one.")
    if otp.attempts >= s.otp_max_attempts:
        raise SignupError("Too many wrong tries. Ask for a new code.", 429)
    if not re.fullmatch(r"\d{6}", code or "") or not hmac.compare_digest(otp.code_hash, _code_hash(org.id, phone, code)):
        otp.attempts += 1
        db.flush()
        raise SignupError("That code is not right. Check WhatsApp and try again.")
    otp.consumed_at = now
    db.flush()
    return phone


def phone_token(org: Org, phone: str) -> str:
    """Proof, for the sign-up form, that this phone was verified at this clinic."""
    s = get_settings()
    claims = {"typ": "phone", "org_id": str(org.id), "phone": phone,
              "exp": datetime.now(UTC) + timedelta(minutes=PHONE_TOKEN_MINUTES)}
    return jwt.encode(claims, s.jwt_secret, algorithm=s.jwt_algorithm)


def read_phone_token(token: str, org: Org) -> str:
    s = get_settings()
    expired = SignupError("Your phone check has expired. Verify your number again.", 401)
    try:
        claims = jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm], options={"require": ["typ", "exp", "phone"]})
    except jwt.PyJWTError as e:
        raise expired from e
    if claims.get("typ") != "phone" or claims.get("org_id") != str(org.id):
        raise expired
    return claims["phone"]


# ─── accounts ──────────────────────────────────────────────────────────────────────────────

def sign_up(db: Session, org: Org, *, full_name: str, email: str, password: str, phone: str,
            phone_verified: bool, details: dict) -> User:
    """A new patient account at this clinic with its OncoReady ID and profile details.

    A phone already used here: a patient account without a password (made before email login)
    is taken over only with a VERIFIED phone; anything else is refused."""
    from app.intake import service as intake

    users = UserRepository(db, org.id)
    email = email.strip().lower()
    if users.get_by_email(email) is not None:
        raise SignupError("An account with this email already exists. Log in instead.", 409)
    now = datetime.now(UTC)
    existing = users.get_by_phone(phone)
    if existing is not None:
        if existing.role != Role.PATIENT.value or existing.password_hash or not phone_verified:
            raise SignupError("This phone number already has an account here. Log in instead.", 409)
        user = existing  # an older phone-only account, now proven by the code: complete it
        user.full_name, user.email, user.password_hash = full_name.strip(), email, hash_password(password)
        user.phone_verified_at = now
    else:
        for _ in range(5):  # a clash of 8 random characters is unlikely; retry if it happens
            try:
                with db.begin_nested():
                    user = users.add(email=email, password_hash=hash_password(password), full_name=full_name.strip(),
                                     role=Role.PATIENT.value, phone=phone, patient_number=new_patient_number(),
                                     phone_verified_at=now if phone_verified else None)
                break
            except IntegrityError:
                continue
        else:
            raise SignupError("Could not create the account. Try again.", 500)
    intake.update_details(db, user, {**details, "phone": phone})
    case = intake.profile_case(db, user)
    case.title = user.full_name
    db.flush()
    return user


def log_in(db: Session, org: Org, email: str, password: str) -> User:
    user = UserRepository(db, org.id).get_by_email(email.strip().lower())
    if (user is None or user.role != Role.PATIENT.value or not user.is_active or not user.password_hash
            or not verify_password(password, user.password_hash)):
        raise SignupError("Wrong email or password.", 401)
    return user
