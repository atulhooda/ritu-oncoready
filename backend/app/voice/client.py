"""The only module that talks to the Ritu voice server. Contract: docs/VOICE_INTEGRATION.md."""

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from datetime import datetime

import httpx

from app.config import get_settings
from app.voice.script import INTAKE_SCRIPT

MAX_SKEW_SECONDS = 300


class RituError(RuntimeError):
    pass


@dataclass(frozen=True)
class BrowserSession:
    session_id: str
    ws_url: str
    token: str
    expires_at: datetime | None


def enabled() -> bool:
    s = get_settings()
    return bool(s.ritu_base_url and s.ritu_shared_secret)


def sign(timestamp: str, body: bytes, secret: str | None = None) -> str:
    key = (secret if secret is not None else get_settings().ritu_shared_secret).encode()
    return hmac.new(key, timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify(timestamp: str | None, signature: str | None, body: bytes, now: float | None = None) -> bool:
    secret = get_settings().ritu_shared_secret
    if not secret or not timestamp or not signature:
        return False
    try:
        if abs((now or time.time()) - int(timestamp)) > MAX_SKEW_SECONDS:
            return False
    except ValueError:
        return False
    return hmac.compare_digest(sign(timestamp, body, secret), signature)


def external_ref(org_id, session_id) -> str:
    return f"oncoready:{org_id}:{session_id}"


def create_browser_session(org_id, session_id, patient_name: str, language: str) -> BrowserSession:
    s = get_settings()
    body = json.dumps({
        "external_ref": external_ref(org_id, session_id),
        "language": language,
        "context": {"patient_display_name": patient_name, "clinic_display_name": s.clinic_display_name},
        "script": INTAKE_SCRIPT,
        "callback_url": f"{s.public_api_url.rstrip('/')}/integrations/ritu/sessions",
        "voice": {"speaker": s.ritu_voice_speaker, "pace": s.ritu_voice_pace, "temperature": s.ritu_voice_temperature},
        "max_duration_s": 600,
    }).encode()
    ts = str(int(time.time()))
    try:
        r = httpx.post(
            f"{s.ritu_base_url.rstrip('/')}/v1/browser-sessions",
            content=body,
            headers={"Content-Type": "application/json", "X-Ritu-Timestamp": ts, "X-Ritu-Signature": sign(ts, body)},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        expires = data.get("expires_at")
        return BrowserSession(
            data["session_id"], data["ws_url"], data["token"], datetime.fromisoformat(expires) if expires else None
        )
    except (httpx.HTTPError, KeyError, ValueError) as e:
        raise RituError(f"could not start Ritu session: {e}") from e
