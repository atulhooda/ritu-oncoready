"""Patient self sign-up at a clinic: phone + one-time code, unique patient ID, clinic separation."""

from datetime import UTC, datetime, timedelta

import pytest

from app.auth import signup, sms
from app.config import get_settings
from app.models import Role
from app.repositories.users import PhoneOtpRepository, UserRepository
from tests.conftest import PASSWORD, login


@pytest.fixture
def clinic(db, org_a):
    org_a.org.join_code, org_a.org.patient_signup_open = "CCC", True
    db.commit()
    return org_a


def code_for(client, phone="98123 45678", clinic_code="CCC"):
    r = client.post(f"/join/{clinic_code}/otp", json={"phone": phone})
    assert r.status_code == 200, r.text
    return r.json()


def sign_up(client, phone="98123 45678", name="Asha Placeholder"):
    otp = code_for(client, phone)
    v = client.post("/join/CCC/verify", json={"phone": phone, "code": otp["demo_code"]}).json()
    return client.post("/join/CCC/register", json={"signup_token": v["signup_token"], "full_name": name, "accept_test_terms": True})


def test_new_patient_signs_up_and_gets_a_patient_id(client, db, clinic):
    info = client.get("/join/ccc").json()
    assert info == {"name": clinic.org.name, "code": "CCC", "sms": "demo"}
    otp = code_for(client)
    assert otp["sent_to"] == "+91 •••••••5678" or otp["sent_to"].endswith("5678")
    assert len(otp["demo_code"]) == 6  # demo mode: no SMS provider configured
    r = client.post("/join/CCC/verify", json={"phone": "+91 98123 45678", "code": otp["demo_code"]})
    token = r.json()["signup_token"]
    assert "access_token" not in r.json()
    # the sign-up token is not a login
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    assert client.post("/join/CCC/register", json={"signup_token": token, "full_name": "Asha", "accept_test_terms": False}).status_code == 422
    r = client.post("/join/CCC/register", json={"signup_token": token, "full_name": "Asha Placeholder", "accept_test_terms": True})
    assert r.status_code == 201
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    me = client.get("/auth/me", headers=h).json()
    assert me["role"] == "patient" and me["email"] is None and me["phone"] == "+919812345678"
    assert me["patient_number"] == r.json()["patient_number"]
    assert me["patient_number"][:3] == "OR-" and len(me["patient_number"]) == 12
    prof = client.get("/me/profile", headers=h).json()
    assert prof["patient_number"] == me["patient_number"] and prof["details"]["phone"] == "+919812345678"


def test_returning_patient_signs_in_with_a_code(client, db, clinic):
    first = sign_up(client).json()
    otp = code_for(client, "+919812345678")
    r = client.post("/join/CCC/verify", json={"phone": "98123 45678", "code": otp["demo_code"]}).json()
    assert "access_token" in r and "signup_token" not in r
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {r['access_token']}"}).json()
    assert me["patient_number"] == first["patient_number"]


def test_wrong_used_and_expired_codes(client, db, clinic):
    otp = code_for(client)
    bad = client.post("/join/CCC/verify", json={"phone": "9812345678", "code": "000000" if otp["demo_code"] != "000000" else "111111"})
    assert bad.status_code == 400 and "not right" in bad.json()["detail"]
    assert client.post("/join/CCC/verify", json={"phone": "9812345678", "code": otp["demo_code"]}).status_code == 200
    again = client.post("/join/CCC/verify", json={"phone": "9812345678", "code": otp["demo_code"]})
    assert again.status_code == 400  # used once only
    otp = code_for(client)
    row = PhoneOtpRepository(db, clinic.org.id).latest_open("+919812345678")
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    r = client.post("/join/CCC/verify", json={"phone": "9812345678", "code": otp["demo_code"]})
    assert r.status_code == 400 and "expired" in r.json()["detail"]


def test_attempts_and_sending_are_limited(client, db, clinic, monkeypatch):
    otp = code_for(client)
    wrong = "123456" if otp["demo_code"] != "123456" else "654321"
    for _ in range(get_settings().otp_max_attempts):
        client.post("/join/CCC/verify", json={"phone": "9812345678", "code": wrong})
    r = client.post("/join/CCC/verify", json={"phone": "9812345678", "code": otp["demo_code"]})
    assert r.status_code == 429  # even the right code, after too many wrong ones
    for _ in range(get_settings().otp_max_per_hour - 1):
        code_for(client)
    assert client.post("/join/CCC/otp", json={"phone": "9812345678"}).status_code == 429


def test_a_code_from_one_clinic_does_not_work_at_another(client, db, clinic, org_b):
    org_b.org.join_code, org_b.org.patient_signup_open = "BBB", True
    db.commit()
    otp = code_for(client)
    assert client.post("/join/BBB/verify", json={"phone": "9812345678", "code": otp["demo_code"]}).status_code == 400
    token = client.post("/join/CCC/verify", json={"phone": "9812345678", "code": otp["demo_code"]}).json()["signup_token"]
    r = client.post("/join/BBB/register", json={"signup_token": token, "full_name": "X Y", "accept_test_terms": True})
    assert r.status_code == 401  # a sign-up token is bound to its clinic


def test_closed_or_unknown_clinic(client, db, clinic):
    assert client.get("/join/NOPE").status_code == 404
    clinic.org.patient_signup_open = False
    db.commit()
    assert client.get("/join/CCC").status_code == 404
    assert client.post("/join/CCC/otp", json={"phone": "9812345678"}).status_code == 404


def test_invalid_numbers_are_refused(client, db, clinic):
    for bad in ("12345", "+91 12345 67890", "phone"):
        assert client.post("/join/CCC/otp", json={"phone": bad}).status_code == 422


def test_sms_provider_sends_the_code_and_never_returns_it(client, db, clinic, monkeypatch):
    sent = {}
    monkeypatch.setattr(sms, "enabled", lambda: True)
    monkeypatch.setattr(sms, "send_otp", lambda phone, code: sent.update(phone=phone, code=code))
    r = code_for(client)
    assert r["demo_code"] is None and sent["phone"] == "+919812345678" and len(sent["code"]) == 6
    assert client.post("/join/CCC/verify", json={"phone": "9812345678", "code": sent["code"]}).status_code == 200


def test_patient_numbers_are_unique_and_staff_login_unchanged(client, db, clinic):
    numbers = {signup.new_patient_number() for _ in range(2000)}
    assert len(numbers) == 2000 and all(n[:3] == "OR-" and n[7] == "-" for n in numbers)
    a = sign_up(client, "9812345678", "Asha P").json()
    b = sign_up(client, "9812345679", "Bina P").json()
    assert a["patient_number"] != b["patient_number"]
    # staff still sign in with email + password; a phone-only patient cannot use that form
    assert login(client, clinic, clinic.faculty)
    assert client.post("/auth/login", json={"org_slug": clinic.org.slug, "email": "x@example.com", "password": "x"}).status_code == 401


def test_same_number_cannot_register_twice(client, db, clinic):
    sign_up(client)
    otp = code_for(client)
    v = client.post("/join/CCC/verify", json={"phone": "9812345678", "code": otp["demo_code"]}).json()
    assert "access_token" in v  # it signs in instead
    token = signup.signup_token(clinic.org, "+919812345678")
    r = client.post("/join/CCC/register", json={"signup_token": token, "full_name": "Again", "accept_test_terms": True})
    assert r.status_code == 409
