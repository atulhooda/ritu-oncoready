"""DigiLocker: verified identity and record import, demo mode and the live OAuth/PKCE exchange."""

import base64
import hashlib
from datetime import date
from urllib.parse import parse_qs, urlparse

import pytest

from app.config import get_settings
from app.identity import digilocker
from app.models import Role
from app.repositories.cases import SourceDocumentRepository
from app.repositories.users import UserRepository
from tests.conftest import PASSWORD, login


class MemoryStore:
    def __init__(self):
        self.d = {}

    def put(self, key, value, ttl):
        self.d[key] = value

    def take(self, key):
        return self.d.pop(key, None)

    def get(self, key):
        return self.d.get(key)


@pytest.fixture(autouse=True)
def memory_store(monkeypatch):
    s = MemoryStore()
    monkeypatch.setattr(digilocker, "_store", s)
    return s


@pytest.fixture(autouse=True)
def no_pipeline(monkeypatch):
    from app.pipeline import tasks

    queued = []
    monkeypatch.setattr(tasks, "enqueue_document", lambda org, doc, case: queued.append(doc))
    return queued


def patient(client, db, tenant, name="Asha Placeholder", email="asha@x.example.com"):
    user = UserRepository(db, tenant.org.id).create(email, name, PASSWORD, Role.PATIENT)
    db.commit()
    return user, login(client, tenant, user)


def finish_demo(client, h):
    start = client.post("/me/digilocker/start", headers=h).json()
    assert start["mode"] == "demo" and start["authorize_url"].startswith("/patient/digilocker?demo=1")
    q = parse_qs(urlparse(start["authorize_url"]).query)
    return client.post("/me/digilocker/complete", headers=h, json={"code": q["code"][0], "state": q["state"][0]}), q


def test_demo_verification_and_import(client, db, org_a, no_pipeline):
    user, h = patient(client, db, org_a)
    client.put("/me/details", headers=h, json={"date_of_birth": "1971-09-30", "sex": "female", "preferred_language": "en-IN"})
    r, _ = finish_demo(client, h)
    assert r.status_code == 200
    ident = r.json()
    assert ident["verified_via"] == "digilocker_demo" and ident["name"] == "Asha Placeholder" and ident["gender"] == "F"
    assert client.get("/me/profile", headers=h).json()["details"]["identity"]["verified_via"] == "digilocker_demo"

    docs = client.get("/me/digilocker/documents", headers=h).json()
    assert docs["mode"] == "demo" and len(docs["documents"]) == 3 and not any(d["imported"] for d in docs["documents"])
    uri = docs["documents"][0]["uri"]
    imp = client.post("/me/digilocker/import", headers=h, json={"uri": uri})
    assert imp.status_code == 202 and imp.json()["filename"] == "OPD consultation note (DigiLocker).pdf"
    assert [str(d) for d in no_pipeline] == [imp.json()["id"]]  # same OCR + extraction pipeline as uploads
    assert client.post("/me/digilocker/import", headers=h, json={"uri": uri}).status_code == 409  # once only
    assert [d["imported"] for d in client.get("/me/digilocker/documents", headers=h).json()["documents"]] == [True, False, False]
    doc = SourceDocumentRepository(db, org_a.org.id).get(imp.json()["id"])
    assert doc.external_ref == f"digilocker:{uri}"


def test_a_state_works_once_and_only_for_its_patient(client, db, org_a):
    _, h1 = patient(client, db, org_a)
    _, h2 = patient(client, db, org_a, "Bina", "bina@x.example.com")
    start = client.post("/me/digilocker/start", headers=h1).json()
    q = parse_qs(urlparse(start["authorize_url"]).query)
    body = {"code": q["code"][0], "state": q["state"][0]}
    assert client.post("/me/digilocker/complete", headers=h2, json=body).status_code == 400  # someone else's state
    start = client.post("/me/digilocker/start", headers=h1).json()
    q = parse_qs(urlparse(start["authorize_url"]).query)
    body = {"code": q["code"][0], "state": q["state"][0]}
    assert client.post("/me/digilocker/complete", headers=h1, json=body).status_code == 200
    assert client.post("/me/digilocker/complete", headers=h1, json=body).status_code == 400  # used


def test_documents_need_a_fresh_connection(client, db, org_a):
    _, h = patient(client, db, org_a)
    r = client.get("/me/digilocker/documents", headers=h)
    assert r.status_code == 409 and "Verify with DigiLocker" in r.json()["detail"]
    assert client.post("/me/digilocker/import", headers=h, json={"uri": "demo-OPDNT-20260720"}).status_code == 409


def test_live_mode_needs_the_real_patient_data_switch(monkeypatch):
    monkeypatch.setattr(get_settings(), "digilocker_client_id", "CID")
    monkeypatch.setattr(get_settings(), "digilocker_client_secret", "SECRET")
    assert digilocker.mode() == "demo"  # credentials alone are not enough (CLAUDE.md rule 2)
    monkeypatch.setattr(get_settings(), "real_patient_data", True)
    assert digilocker.mode() == "live"


def test_live_exchange_sends_the_pkce_verifier_and_reads_the_identity(client, db, org_a, monkeypatch):
    monkeypatch.setattr(get_settings(), "digilocker_client_id", "CID")
    monkeypatch.setattr(get_settings(), "digilocker_client_secret", "SECRET")
    monkeypatch.setattr(get_settings(), "digilocker_redirect_uri", "https://app.example/patient/digilocker")
    monkeypatch.setattr(get_settings(), "real_patient_data", True)
    _, h = patient(client, db, org_a)
    url = client.post("/me/digilocker/start", headers=h).json()["authorize_url"]
    parts = urlparse(url)
    q = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert url.startswith("https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize?")
    assert q["response_type"] == "code" and q["client_id"] == "CID" and q["code_challenge_method"] == "S256"
    assert q["redirect_uri"] == "https://app.example/patient/digilocker"
    sent = {}

    class Reply:
        status_code = 200
        def __init__(self, data):
            self._d = data
        def raise_for_status(self):
            pass
        def json(self):
            return self._d

    def post(u, data, timeout):
        sent.update(url=u, data=data)
        return Reply({"access_token": "at", "expires_in": 3600, "name": "Asha Kumari", "dob": "30091971", "gender": "F",
                      "digilockerid": "x" * 36})

    monkeypatch.setattr(digilocker.httpx, "post", post)
    r = client.post("/me/digilocker/complete", headers=h, json={"code": "real-code", "state": q["state"]})
    assert r.status_code == 200, r.text
    assert sent["url"].endswith("/oauth2/1/token") and sent["data"]["grant_type"] == "authorization_code"
    verifier = sent["data"]["code_verifier"]
    assert base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode() == q["code_challenge"]
    ident = r.json()
    assert (ident["name"], ident["dob"], ident["gender"], ident["verified_via"]) == ("Asha Kumari", "1971-09-30", "F", "digilocker")
    details = client.get("/me/profile", headers=h).json()["details"]
    assert details["date_of_birth"] == "1971-09-30" and details["sex"] == "female"  # filled from DigiLocker


def test_doctor_sees_the_verified_identity(client, db, org_a):
    from datetime import UTC, datetime

    from app.intake import service

    user, h = patient(client, db, org_a)
    finish_demo(client, h)
    case = service.profile_case(db, user)
    case.published_at = datetime.now(UTC)
    doctor = UserRepository(db, org_a.org.id).create("dr@x.example.com", "Dr", PASSWORD, Role.DOCTOR)
    db.commit()
    detail = client.get(f"/doctor/patients/{case.id}", headers=login(client, org_a, doctor)).json()
    assert detail["details"]["identity"]["verified_via"] == "digilocker_demo"
    assert date.fromisoformat(detail["details"]["identity"]["verified_at"][:10])
