"""The only module that talks to DigiLocker (Meri Pehchaan, Requester API v2.4).

Flow (OAuth 2.0 authorization code + PKCE, both required by DigiLocker):
  start()     -> authorize URL: .../oauth2/1/authorize?response_type=code&client_id&redirect_uri
                 &state&code_challenge(S256)
  complete()  -> POST .../oauth2/1/token (code, client id/secret, redirect_uri, code_verifier).
                 The token response itself carries the verified identity: name, dob (DDMMYYYY),
                 gender (M/F/T), digilockerid.
  documents() -> GET .../oauth2/2/files/issued (issued documents) and .../oauth2/1/files/ (the
                 user's own uploads, root folder)
  fetch()     -> GET .../oauth2/1/file/{uri}

LIVE MODE needs DigiLocker partner credentials AND `REAL_PATIENT_DATA=true`: DigiLocker returns
real, Aadhaar-backed identity, which CLAUDE.md rule 2 keeps out until the service is cleared for
real patients. Otherwise DEMO MODE: no request leaves the server, a demo consent screen stands in
for DigiLocker, the identity is labelled demo, and the documents are synthetic seed PDFs.

The PKCE verifier and the access token live only in Redis, for minutes, never in the database.
"""

import base64
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import quote, urlencode

import httpx

from app.config import get_settings

STATE_TTL = 600  # seconds to finish the DigiLocker sign-in
TOKEN_TTL = 900  # how long imports stay possible after verifying
TIMEOUT = 20.0


class DigiLockerError(RuntimeError):
    pass


@dataclass(frozen=True)
class Identity:
    name: str | None
    dob: date | None
    gender: str | None  # M / F / T


def mode() -> str:
    s = get_settings()
    return "live" if (s.digilocker_client_id and s.digilocker_client_secret and s.real_patient_data) else "demo"


def _base() -> str:
    return get_settings().digilocker_base_url.rstrip("/")


# ─── short-lived state (Redis) ──────────────────────────────────────────────────────────

class RedisStore:
    def __init__(self):
        import redis

        self.r = redis.from_url(get_settings().redis_url)

    def put(self, key: str, value: dict, ttl: int) -> None:
        self.r.setex(key, ttl, json.dumps(value))

    def take(self, key: str) -> dict | None:
        """Read and delete: a state is good for one use."""
        raw = self.r.getdel(key)
        return json.loads(raw) if raw else None

    def get(self, key: str) -> dict | None:
        raw = self.r.get(key)
        return json.loads(raw) if raw else None


_store = None


def store():
    global _store
    if _store is None:
        _store = RedisStore()
    return _store


def _token_key(org_id: uuid.UUID, user_id: uuid.UUID) -> str:
    return f"digilocker:token:{org_id}:{user_id}"


# ─── the flow ───────────────────────────────────────────────────────────────────────────

def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)[:96]  # 43-128 chars from [A-Za-z0-9-._~]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def start(org_id: uuid.UUID, user_id: uuid.UUID) -> str:
    """The URL to send the patient's browser to."""
    s = get_settings()
    state = secrets.token_urlsafe(24)
    verifier, challenge = pkce_pair()
    store().put(f"digilocker:state:{state}", {"org_id": str(org_id), "user_id": str(user_id), "verifier": verifier}, STATE_TTL)
    if mode() == "demo":
        # Our own stand-in consent screen; it returns to the same callback page with a demo code.
        return f"/patient/digilocker?demo=1&state={state}&code=demo-{secrets.token_urlsafe(12)}"
    return f"{_base()}/1/authorize?" + urlencode({
        "response_type": "code", "client_id": s.digilocker_client_id, "redirect_uri": s.digilocker_redirect_uri,
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "purpose": "verification",
    })


def _parse_dob(raw: str | None) -> date | None:
    if not raw or len(raw) != 8 or not raw.isdigit():
        return None
    try:
        return date(int(raw[4:]), int(raw[2:4]), int(raw[:2]))  # DDMMYYYY
    except ValueError:
        return None


def complete(org_id: uuid.UUID, user_id: uuid.UUID, code: str, state: str, demo_identity: Identity) -> Identity:
    """Exchange the code. The state must be this user's, unused and unexpired."""
    saved = store().take(f"digilocker:state:{state}")
    if not saved or saved["org_id"] != str(org_id) or saved["user_id"] != str(user_id):
        raise DigiLockerError("This DigiLocker sign-in has expired or is not yours. Start again.")
    if mode() == "demo":
        if not code.startswith("demo-"):
            raise DigiLockerError("DigiLocker is in demo mode here.")
        store().put(_token_key(org_id, user_id), {"token": "demo"}, TOKEN_TTL)
        return demo_identity
    s = get_settings()
    try:
        r = httpx.post(f"{_base()}/1/token", data={
            "code": code, "grant_type": "authorization_code", "client_id": s.digilocker_client_id,
            "client_secret": s.digilocker_client_secret, "redirect_uri": s.digilocker_redirect_uri,
            "code_verifier": saved["verifier"],
        }, timeout=TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise DigiLockerError(f"DigiLocker did not accept the sign-in: {e}") from e
    if not data.get("access_token"):
        raise DigiLockerError(data.get("error_description") or "DigiLocker returned no access token")
    store().put(_token_key(org_id, user_id), {"token": data["access_token"]},
                min(TOKEN_TTL, int(data.get("expires_in") or TOKEN_TTL)))
    gender = data.get("gender") if data.get("gender") in ("M", "F", "T") else None
    return Identity(name=(data.get("name") or "").strip() or None, dob=_parse_dob(data.get("dob")), gender=gender)


def _token(org_id: uuid.UUID, user_id: uuid.UUID) -> str:
    saved = store().get(_token_key(org_id, user_id))
    if not saved:
        raise DigiLockerError("Your DigiLocker connection has ended. Verify with DigiLocker again to import documents.")
    return saved["token"]


# Synthetic stand-ins for a DigiLocker (demo mode): seed PDFs shipped with the app.
DEMO_DOCUMENTS = [
    ("demo-OPDNT-20260720", "OPD consultation note", "Synthetic General Hospital", "2026-07-20", "personas/records/maria_clinic_note_2026-07-20.pdf"),
    ("demo-PATHR-20250210", "Pathology report", "Synthetic General Hospital - Pathology", "2025-02-10", "cases/SYN-003/docs/syn-003_pathology.pdf"),
    ("demo-IMGRP-20260105", "CT scan report", "Synthetic Imaging Centre", "2026-01-05", "cases/SYN-002/docs/syn-002_outside_ct.pdf"),
]


def _seed_dir() -> Path:
    for p in (Path(get_settings().seed_dir), Path(__file__).resolve().parents[3] / "seed"):
        if p.is_dir():
            return p
    raise DigiLockerError("Demo documents are not available on this server")


def documents(org_id: uuid.UUID, user_id: uuid.UUID) -> list[dict]:
    token = _token(org_id, user_id)
    if token == "demo":
        return [{"uri": uri, "name": name, "issuer": issuer, "date": when, "mime": "application/pdf", "source": "issued"}
                for uri, name, issuer, when, _ in DEMO_DOCUMENTS]
    headers = {"Authorization": f"Bearer {token}"}
    out = []
    try:
        issued = httpx.get(f"{_base()}/2/files/issued", headers=headers, timeout=TIMEOUT)
        issued.raise_for_status()
        for d in issued.json().get("items", []):
            out.append({"uri": (d.get("uri") or "").strip(), "name": d.get("name") or d.get("description") or "Document",
                        "issuer": d.get("issuer"), "date": (d.get("date") or "").strip()[:10] or None,
                        "mime": str(d.get("mime")), "source": "issued"})
        uploaded = httpx.get(f"{_base()}/1/files/", headers=headers, timeout=TIMEOUT)
        if uploaded.status_code == 200:
            for d in uploaded.json().get("items", []):
                if d.get("type") == "file" and d.get("uri"):
                    out.append({"uri": d["uri"], "name": d.get("name") or "Uploaded document", "issuer": "Uploaded by you",
                                "date": (d.get("date") or "")[:10] or None, "mime": d.get("mime") or "", "source": "uploaded"})
    except (httpx.HTTPError, ValueError) as e:
        raise DigiLockerError(f"Could not list your DigiLocker documents: {e}") from e
    return [d for d in out if d["uri"]]


def fetch(org_id: uuid.UUID, user_id: uuid.UUID, uri: str) -> tuple[bytes, str]:
    """The document's bytes and its name."""
    token = _token(org_id, user_id)
    if token == "demo":
        match = next((d for d in DEMO_DOCUMENTS if d[0] == uri), None)
        if match is None:
            raise DigiLockerError("Document not found")
        return (_seed_dir() / match[4]).read_bytes(), match[1]
    try:
        r = httpx.get(f"{_base()}/1/file/{quote(uri, safe='')}", headers={"Authorization": f"Bearer {token}"}, timeout=60)
        r.raise_for_status()
    except httpx.HTTPError as e:
        raise DigiLockerError(f"Could not download the document from DigiLocker: {e}") from e
    return r.content, uri
