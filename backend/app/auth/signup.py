"""Patient self sign-up at a clinic: phone + one-time code, then a name. Rules: BEHAVIOR_SPEC.md
"Patient sign-up".

  /join/<code>  ->  request_otp(phone)  ->  verify(phone, code)
                       existing patient at this clinic -> signed in
                       new phone                       -> signup token -> register(name) -> signed in
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

from app.auth import sms
from app.config import get_settings
from app.models import Org, Role, User
from app.repositories.users import PhoneOtpRepository, UserRepository

SIGNUP_TOKEN_MINUTES = 15
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


def request_otp(db: Session, org: Org, raw_phone: str) -> tuple[str, str | None]:
    """Create and send a code. Returns (phone, code-if-demo). Rate limited per phone and clinic."""
    s = get_settings()
    phone = normalize_phone(raw_phone)
    otps = PhoneOtpRepository(db, org.id)
    now = datetime.now(UTC)
    if otps.sent_since(phone, now - timedelta(hours=1)) >= s.otp_max_per_hour:
        raise SignupError("Too many codes for this number. Try again in an hour.", 429)
    code = f"{secrets.randbelow(10**6):06d}"
    otps.add(phone=phone, code_hash=_code_hash(org.id, phone, code), expires_at=now + timedelta(seconds=s.otp_ttl_seconds))
    db.flush()
    if sms.enabled():
        try:
            sms.send_otp(phone, code)
        except sms.SmsError as e:
            raise SignupError(str(e), 502) from e
        return phone, None
    return phone, code  # demo: shown on screen


def verify_otp(db: Session, org: Org, raw_phone: str, code: str) -> str:
    """Checks the newest open code for this phone at this clinic. Returns the phone on success."""
    s = get_settings()
    phone = normalize_phone(raw_phone)
    otp = PhoneOtpRepository(db, org.id).latest_open(phone)
    now = datetime.now(UTC)
    wrong = SignupError("That code is not right. Check the SMS and try again.")
    if otp is None or otp.expires_at <= now:
        raise SignupError("The code has expired. Ask for a new one.")
    if otp.attempts >= s.otp_max_attempts:
        raise SignupError("Too many wrong tries. Ask for a new code.", 429)
    if not re.fullmatch(r"\d{6}", code or "") or not hmac.compare_digest(otp.code_hash, _code_hash(org.id, phone, code)):
        otp.attempts += 1
        db.flush()
        raise wrong
    otp.consumed_at = now
    db.flush()
    return phone


# ─── WhatsApp: the patient sends the code; Meta's webhook vouches for the sender ─────────────

JOIN_MESSAGE = re.compile(r"\bJOIN\s+([A-Z0-9]{3,16})\s+(\d{6})\b", re.I)


def start_whatsapp(db: Session, org: Org, raw_phone: str) -> tuple[uuid.UUID, str, str]:
    """A code for the patient to send from their WhatsApp. Returns (challenge id, phone, message)."""
    s = get_settings()
    phone = normalize_phone(raw_phone)
    otps = PhoneOtpRepository(db, org.id)
    now = datetime.now(UTC)
    if otps.sent_since(phone, now - timedelta(hours=1)) >= s.otp_max_per_hour:
        raise SignupError("Too many tries for this number. Try again in an hour.", 429)
    code = f"{secrets.randbelow(10**6):06d}"
    otp = otps.add(phone=phone, channel="whatsapp", code_hash=_code_hash(org.id, phone, code),
                   expires_at=now + timedelta(seconds=s.otp_ttl_seconds))
    db.flush()
    return otp.id, phone, f"JOIN {org.join_code} {code}"


def confirm_whatsapp(db: Session, sender: str, text: str) -> bool:
    """A WhatsApp message arrived (webhook, signature already checked). Confirms the sender's open
    challenge when the clinic code and the 6-digit code match. Returns whether it confirmed one."""
    from app.repositories.orgs import OrgRepository

    m = JOIN_MESSAGE.search(text or "")
    if not m:
        return False
    org = OrgRepository(db).get_by_join_code(m.group(1))
    try:
        phone = normalize_phone("+" + sender.lstrip("+"))
    except SignupError:
        return False
    if org is None:
        return False
    otp = PhoneOtpRepository(db, org.id).latest_open(phone, channel="whatsapp")
    now = datetime.now(UTC)
    if otp is None or otp.expires_at <= now or otp.attempts >= get_settings().otp_max_attempts:
        return False
    if not hmac.compare_digest(otp.code_hash, _code_hash(org.id, phone, m.group(2))):
        otp.attempts += 1
        db.flush()
        return False
    otp.confirmed_at = now
    db.flush()
    return True


def whatsapp_status(db: Session, org: Org, challenge_id: uuid.UUID, raw_phone: str) -> str | None:
    """The page that started a challenge asks if it is done. Returns the phone once confirmed (and
    uses the challenge up), None while waiting."""
    phone = normalize_phone(raw_phone)
    otp = PhoneOtpRepository(db, org.id).get(challenge_id)
    if otp is None or otp.phone != phone or otp.channel != "whatsapp" or otp.consumed_at is not None:
        raise SignupError("This verification is not valid any more. Start again.", 404)
    if otp.confirmed_at is None:
        if otp.expires_at <= datetime.now(UTC):
            raise SignupError("The code has expired. Start again.", 410)
        return None
    otp.consumed_at = datetime.now(UTC)
    db.flush()
    return phone


def signup_token(org: Org, phone: str) -> str:
    s = get_settings()
    claims = {"typ": "signup", "org_id": str(org.id), "phone": phone,
              "exp": datetime.now(UTC) + timedelta(minutes=SIGNUP_TOKEN_MINUTES)}
    return jwt.encode(claims, s.jwt_secret, algorithm=s.jwt_algorithm)


def read_signup_token(token: str, org: Org) -> str:
    s = get_settings()
    try:
        claims = jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm], options={"require": ["typ", "exp", "phone"]})
    except jwt.PyJWTError as e:
        raise SignupError("Your sign-up session expired. Verify your number again.", 401) from e
    if claims.get("typ") != "signup" or claims.get("org_id") != str(org.id):
        raise SignupError("Your sign-up session expired. Verify your number again.", 401)
    return claims["phone"]


def register(db: Session, org: Org, phone: str, full_name: str) -> User:
    """A new patient account at this clinic, with its OncoReady patient ID and an empty profile."""
    from app.intake import service as intake

    users = UserRepository(db, org.id)
    if users.get_by_phone(phone) is not None:
        raise SignupError("This number already has an account here. Sign in instead.", 409)
    for _ in range(5):  # a clash of 8 random characters is unlikely; retry if it happens
        try:
            with db.begin_nested():
                user = users.add(email=None, password_hash=None, full_name=full_name.strip(), role=Role.PATIENT.value,
                                 phone=phone, patient_number=new_patient_number())
            break
        except IntegrityError:
            continue
    else:
        raise SignupError("Could not create the account. Try again.", 500)
    intake.update_details(db, user, {"phone": phone})
    intake.profile_case(db, user)
    db.flush()
    return user
