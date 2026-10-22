"""The only module that talks to ABDM (Ayushman Bharat Digital Mission), for linking a patient's ABHA.

SANDBOX ONLY. OncoReady holds synthetic personas (CLAUDE.md rule 2), so every ABDM host must be a
sandbox host; anything else is refused before a request is made. Sandbox ABHAs are test accounts.

Flow (ABHA v3, login with ABHA number + OTP to the mobile linked to that ABHA):
  1. gateway session:  POST {gateway}/gateway/v3/sessions {clientId, clientSecret, grantType}
  2. request OTP:      POST {abha}/v3/profile/login/request/otp
                       {scope: [abha-login, mobile-verify], loginHint: abha-number, loginId: enc(number), otpSystem: abdm}
  3. verify OTP:       POST {abha}/v3/profile/login/verify
                       {scope, authData: {authMethods: [otp], otp: {txnId, otpValue: enc(otp)}}}
Sensitive values are RSA-OAEP (SHA-1) encrypted with ABDM's public certificate. ABDM's response
shapes are only partly documented, so they are read leniently and checked against what was typed.

Without a client id/secret this runs in DEMO mode: no network, the OTP is DEMO_OTP, and the link is
stored as "demo" so nobody mistakes it for a verified one.
"""

import base64
import re
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.x509 import load_pem_x509_certificate

from app.config import get_settings

DEMO_OTP = "123456"
SANDBOX_HOSTS = ("dev.abdm.gov.in", "abhasbx.abdm.gov.in", "healthidsbx.abdm.gov.in", "phrsbx.abdm.gov.in")
SCOPE = ["abha-login", "mobile-verify"]
TIMEOUT = 20.0


class AbdmError(RuntimeError):
    pass


@dataclass(frozen=True)
class AbhaAccount:
    abha_number: str  # 14 digits, no hyphens
    abha_address: str | None
    name: str | None


def enabled() -> bool:
    s = get_settings()
    return bool(s.abdm_client_id and s.abdm_client_secret)


def mode() -> str:
    return "abdm_sandbox" if enabled() else "demo"


def normalize_abha_number(value: str) -> str:
    digits = re.sub(r"[\s-]", "", value or "")
    if not re.fullmatch(r"\d{14}", digits):
        raise ValueError("An ABHA number has 14 digits, like 91-1234-5678-9012")
    return digits


def masked(abha_number: str) -> str:
    """Only the last four digits are kept: XX-XXXX-XXXX-9012."""
    return f"XX-XXXX-XXXX-{abha_number[-4:]}"


def _sandbox_url(url: str) -> str:
    host = urlparse(url).hostname or ""
    if host not in SANDBOX_HOSTS:
        raise AbdmError(f"refusing ABDM host {host!r}: only the ABDM sandbox is allowed")
    return url.rstrip("/")


def _headers(token: str | None = None) -> dict[str, str]:
    h = {
        "Content-Type": "application/json",
        "REQUEST-ID": str(uuid.uuid4()),
        "TIMESTAMP": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "X-CM-ID": get_settings().abdm_cm_id,
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _post(url: str, body: dict, token: str | None = None) -> dict:
    try:
        r = httpx.post(_sandbox_url(url), json=body, headers=_headers(token), timeout=TIMEOUT)
    except httpx.HTTPError as e:
        raise AbdmError(f"ABDM unreachable: {e}") from e
    if r.status_code >= 400:
        raise AbdmError(f"ABDM {r.status_code}: {r.text[:300]}")
    try:
        return r.json()
    except ValueError as e:
        raise AbdmError("ABDM returned a non-JSON response") from e


_session: dict[str, float | str] = {}


def _gateway_token() -> str:
    if _session.get("token") and float(_session["expires"]) > time.time() + 60:
        return str(_session["token"])
    s = get_settings()
    data = _post(f"{s.abdm_gateway_url}/gateway/v3/sessions",
                 {"clientId": s.abdm_client_id, "clientSecret": s.abdm_client_secret, "grantType": "client_credentials"})
    token = data.get("accessToken")
    if not token:
        raise AbdmError("ABDM session response had no accessToken")
    _session.update(token=token, expires=time.time() + float(data.get("expiresIn") or 600))
    return token


_public_key = None


def _key():
    """ABDM's public key, from a PEM certificate or a bare base64 key (both are seen in the wild)."""
    global _public_key
    if _public_key is not None:
        return _public_key
    s = get_settings()
    url = _sandbox_url(s.abdm_cert_url or f"{s.abdm_abha_url}/v3/profile/public/certificate")
    try:
        r = httpx.get(url, headers=_headers(_gateway_token()), timeout=TIMEOUT)
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise AbdmError(f"could not fetch ABDM certificate: {e}") from e
    text = r.text
    try:
        text = r.json().get("publicKey") or text
    except ValueError:
        pass
    body = re.sub(r"-----[A-Z ]+-----|\s", "", text)
    der = base64.b64decode(body)
    try:
        _public_key = serialization.load_der_public_key(der)
    except ValueError:
        _public_key = load_pem_x509_certificate(
            b"-----BEGIN CERTIFICATE-----\n" + base64.encodebytes(der) + b"-----END CERTIFICATE-----\n"
        ).public_key()
    return _public_key


def encrypt(value: str) -> str:
    cipher = _key().encrypt(
        value.encode(), padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA1()), algorithm=hashes.SHA1(), label=None)
    )
    return base64.b64encode(cipher).decode()


def request_otp(abha_number: str) -> str:
    """Sends an OTP to the mobile linked with this ABHA. Returns the transaction id."""
    number = normalize_abha_number(abha_number)
    if not enabled():
        return f"demo-{uuid.uuid4()}"
    data = _post(f"{get_settings().abdm_abha_url}/v3/profile/login/request/otp",
                 {"scope": SCOPE, "loginHint": "abha-number", "loginId": encrypt(number), "otpSystem": "abdm"},
                 token=_gateway_token())
    txn = data.get("txnId")
    if not txn:
        raise AbdmError(data.get("message") or "ABDM did not start an OTP transaction")
    return txn


def _first(d: dict, *keys: str):
    for k in keys:
        v = d.get(k)
        if isinstance(v, list):
            v = v[0] if v else None
        if v:
            return v
    return None


def verify_otp(txn_id: str, otp: str, abha_number: str) -> AbhaAccount:
    """Checks the OTP. The account ABDM returns must be the ABHA number the patient typed."""
    number = normalize_abha_number(abha_number)
    if not re.fullmatch(r"\d{4,8}", otp or ""):
        raise ValueError("Enter the OTP sent to your mobile")
    if not enabled():
        if not txn_id.startswith("demo-") or otp != DEMO_OTP:
            raise AbdmError("That OTP is not right")
        return AbhaAccount(abha_number=number, abha_address=None, name=None)
    data = _post(f"{get_settings().abdm_abha_url}/v3/profile/login/verify",
                 {"scope": SCOPE, "authData": {"authMethods": ["otp"], "otp": {"txnId": txn_id, "otpValue": encrypt(otp)}}},
                 token=_gateway_token())
    accounts = data.get("accounts") or ([data["ABHAProfile"]] if isinstance(data.get("ABHAProfile"), dict) else [])
    if not accounts:
        raise AbdmError(data.get("message") or "OTP not accepted")
    for acc in accounts:
        found = re.sub(r"\D", "", str(_first(acc, "ABHANumber", "abhaNumber", "healthIdNumber") or ""))
        if found == number:
            return AbhaAccount(
                abha_number=number,
                abha_address=_first(acc, "preferredAbhaAddress", "abhaAddress", "phrAddress", "healthId"),
                name=_first(acc, "name", "fullName"),
            )
    raise AbdmError("ABDM returned a different ABHA than the one entered")
