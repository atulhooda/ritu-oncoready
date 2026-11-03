"""Patient accounts at a clinic: sign up (name, email, phone, password, details; phone checked with
a code sent to WhatsApp when that is set up), log in with email + password, edit the account."""

from datetime import UTC, datetime, timedelta

import pytest

from app.auth import signup, whatsapp
from app.config import get_settings
from app.models import Role
from app.repositories.users import PhoneOtpRepository, UserRepository
from tests.conftest import PASSWORD, login

DETAILS = {"date_of_birth": "1975-06-15", "sex": "female", "preferred_language": "hi-IN", "accept_test_terms": True}


@pytest.fixture
def clinic(db, org_a):
    org_a.org.join_code, org_a.org.patient_signup_open = "CCC", True
    db.commit()
    return org_a


@pytest.fixture
def wa(monkeypatch):
    """WhatsApp set up; codes are captured instead of sent."""
    s = get_settings()
    monkeypatch.setattr(s, "whatsapp_access_token", "tok")
    monkeypatch.setattr(s, "whatsapp_phone_number_id", "123")
    monkeypatch.setattr(s, "whatsapp_otp_template", "oncoready_code")
    sent = []
    monkeypatch.setattr(whatsapp, "send_code", lambda phone, code: sent.append((phone, code)))
    return sent


def form(**over):
    return {"full_name": "Asha Placeholder", "email": "asha@example.com", "phone": "98123 45678",
            "password": "asha-secret-1", **DETAILS, **over}


def verified_token(client, wa, phone="98123 45678", clinic_code="CCC"):
    assert client.post(f"/join/{clinic_code}/phone/send", json={"phone": phone}).status_code == 200
    code = wa[-1][1]
    r = client.post(f"/join/{clinic_code}/phone/verify", json={"phone": phone, "code": code})
    assert r.status_code == 200, r.text
    return r.json()["phone_token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_sign_up_without_phone_check_then_log_in(client, db, clinic):
    info = client.get("/join/ccc").json()
    assert info == {"name": clinic.org.name, "code": "CCC", "phone_check": False}
    assert client.post("/join/CCC/phone/send", json={"phone": "9812345678"}).status_code == 409  # not set up
    r = client.post("/join/CCC/signup", json=form())
    assert r.status_code == 201, r.text
    assert r.json()["patient_number"].startswith("OR-")
    prof = client.get("/me/profile", headers=auth(r.json()["access_token"])).json()
    assert (prof["name"], prof["email"], prof["phone"], prof["phone_verified"]) == ("Asha Placeholder", "asha@example.com", "+919812345678", False)
    d = prof["details"]
    assert (d["date_of_birth"], d["sex"], d["preferred_language"], d["phone"]) == ("1975-06-15", "female", "hi-IN", "+919812345678")

    ok = client.post("/join/CCC/login", json={"email": "ASHA@example.com", "password": "asha-secret-1"})
    assert ok.status_code == 200 and client.get("/auth/me", headers=auth(ok.json()["access_token"])).json()["role"] == "patient"
    assert client.post("/join/CCC/login", json={"email": "asha@example.com", "password": "wrong-one"}).status_code == 401
    assert client.post("/join/CCC/login", json={"email": "nobody@example.com", "password": "x"}).status_code == 401


def test_phone_is_checked_with_a_whatsapp_code(client, db, clinic, wa):
    assert client.get("/join/CCC").json()["phone_check"] is True
    assert client.post("/join/CCC/signup", json=form()).status_code == 422  # must verify first
    token = verified_token(client, wa)
    assert wa[-1][0] == "+919812345678" and len(wa[-1][1]) == 6
    assert client.post("/join/CCC/signup", json=form(phone="9812345679", phone_token=token)).status_code == 422  # other phone
    r = client.post("/join/CCC/signup", json=form(phone_token=token))
    assert r.status_code == 201, r.text
    assert client.get("/me/profile", headers=auth(r.json()["access_token"])).json()["phone_verified"] is True


def test_wrong_used_and_expired_codes(client, db, clinic, wa):
    client.post("/join/CCC/phone/send", json={"phone": "9812345678"})
    code = wa[-1][1]
    wrong = "000000" if code != "000000" else "111111"
    bad = client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": wrong})
    assert bad.status_code == 400 and "not right" in bad.json()["detail"]
    assert client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": code}).status_code == 200
    assert client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": code}).status_code == 400  # once
    client.post("/join/CCC/phone/send", json={"phone": "9812345678"})
    row = PhoneOtpRepository(db, clinic.org.id).latest_open("+919812345678", channel="whatsapp")
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    r = client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": wa[-1][1]})
    assert r.status_code == 400 and "expired" in r.json()["detail"]


def test_attempts_and_sending_are_limited(client, db, clinic, wa):
    client.post("/join/CCC/phone/send", json={"phone": "9812345678"})
    code = wa[-1][1]
    wrong = "123456" if code != "123456" else "654321"
    for _ in range(get_settings().otp_max_attempts):
        client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": wrong})
    assert client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": code}).status_code == 429
    for _ in range(get_settings().otp_max_per_hour - 1):
        client.post("/join/CCC/phone/send", json={"phone": "9812345678"})
    assert client.post("/join/CCC/phone/send", json={"phone": "9812345678"}).status_code == 429


def test_codes_and_phone_tokens_belong_to_their_clinic(client, db, clinic, org_b, wa):
    org_b.org.join_code, org_b.org.patient_signup_open = "BBB", True
    db.commit()
    client.post("/join/CCC/phone/send", json={"phone": "9812345678"})
    assert client.post("/join/BBB/phone/verify", json={"phone": "9812345678", "code": wa[-1][1]}).status_code == 400
    token = client.post("/join/CCC/phone/verify", json={"phone": "9812345678", "code": wa[-1][1]}).json()["phone_token"]
    assert client.post("/join/BBB/signup", json=form(phone_token=token)).status_code == 401


def test_whatsapp_failure_is_reported(client, db, clinic, wa, monkeypatch):
    def down(phone, code):
        raise whatsapp.WhatsAppError("WhatsApp did not send the code: template not approved")
    monkeypatch.setattr(whatsapp, "send_code", down)
    r = client.post("/join/CCC/phone/send", json={"phone": "9812345678"})
    assert r.status_code == 502 and "template" in r.json()["detail"]


def test_the_code_goes_out_as_an_authentication_template(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "whatsapp_access_token", "tok")
    monkeypatch.setattr(s, "whatsapp_phone_number_id", "123")
    monkeypatch.setattr(s, "whatsapp_otp_template", "oncoready_code")
    sent = {}

    class Reply:
        status_code = 200

    monkeypatch.setattr(whatsapp.httpx, "post", lambda url, json, headers, timeout: sent.update(url=url, json=json) or Reply())
    whatsapp.send_code("+919812345678", "482913")
    t = sent["json"]["template"]
    assert sent["url"].endswith("/123/messages") and sent["json"]["to"] == "919812345678"
    assert t["name"] == "oncoready_code" and t["components"][0]["parameters"][0]["text"] == "482913"
    assert t["components"][1]["sub_type"] == "url" and t["components"][1]["parameters"][0]["text"] == "482913"


@pytest.mark.parametrize("over", [
    {"date_of_birth": "2999-01-01"}, {"sex": None}, {"email": "not-an-email"}, {"password": "short"},
    {"accept_test_terms": False}, {"full_name": "A"}, {"phone": "12345"},
])
def test_sign_up_form_is_validated(client, db, clinic, over):
    body = {k: v for k, v in form(**over).items() if v is not None}
    assert client.post("/join/CCC/signup", json=body).status_code == 422


def test_one_account_per_email_and_per_phone(client, db, clinic):
    assert client.post("/join/CCC/signup", json=form()).status_code == 201
    r = client.post("/join/CCC/signup", json=form(phone="9812345679"))
    assert r.status_code == 409 and "email" in r.json()["detail"]
    r = client.post("/join/CCC/signup", json=form(email="other@example.com"))
    assert r.status_code == 409 and "phone" in r.json()["detail"]


def test_an_older_phone_only_account_is_claimed_only_with_a_verified_phone(client, db, clinic, wa):
    users = UserRepository(db, clinic.org.id)
    old = users.add(email=None, password_hash=None, full_name="Old", role=Role.PATIENT.value,
                    phone="+919812345678", patient_number="OR-OLD0-0001")
    db.commit()
    token = verified_token(client, wa)
    r = client.post("/join/CCC/signup", json=form(phone_token=token))
    assert r.status_code == 201 and r.json()["patient_number"] == "OR-OLD0-0001"  # same account, completed
    db.refresh(old)
    assert old.email == "asha@example.com" and old.password_hash and old.phone_verified_at


def test_patients_edit_their_account_and_password(client, db, clinic):
    h = auth(client.post("/join/CCC/signup", json=form()).json()["access_token"])
    client.post("/join/CCC/signup", json=form(email="bina@example.com", phone="9812345679"))
    r = client.put("/me/account", headers=h, json={"full_name": "Asha P. Kumar", "email": "asha.k@example.com"})
    assert r.status_code == 200 and r.json() == {"name": "Asha P. Kumar", "email": "asha.k@example.com"}
    assert client.put("/me/account", headers=h, json={"full_name": "Asha", "email": "bina@example.com"}).status_code == 409
    prof = client.get("/me/profile", headers=h).json()
    assert prof["name"] == "Asha P. Kumar"
    assert client.put("/me/password", headers=h, json={"current_password": "wrong", "new_password": "new-secret-2"}).status_code == 400
    assert client.put("/me/password", headers=h, json={"current_password": "asha-secret-1", "new_password": "new-secret-2"}).status_code == 204
    assert client.post("/join/CCC/login", json={"email": "asha.k@example.com", "password": "new-secret-2"}).status_code == 200
    assert client.post("/join/CCC/login", json={"email": "asha.k@example.com", "password": "asha-secret-1"}).status_code == 401


def test_main_page_uses_the_clinic_without_a_code(client, db, clinic, org_b, monkeypatch):
    assert client.get("/join").json()["code"] == "CCC"
    org_b.org.join_code, org_b.org.patient_signup_open = "BBB", True
    db.commit()
    assert client.get("/join").status_code == 404
    monkeypatch.setattr(get_settings(), "default_clinic_code", "BBB")
    assert client.get("/join").json()["code"] == "BBB"


def test_closed_or_unknown_clinic(client, db, clinic):
    assert client.get("/join/NOPE").status_code == 404
    clinic.org.patient_signup_open = False
    db.commit()
    assert client.get("/join/CCC").status_code == 404
    assert client.post("/join/CCC/signup", json=form()).status_code == 404


def test_patient_numbers_are_unique_and_staff_login_unchanged(client, db, clinic):
    numbers = {signup.new_patient_number() for _ in range(2000)}
    assert len(numbers) == 2000 and all(n[:3] == "OR-" and n[7] == "-" for n in numbers)
    assert login(client, clinic, clinic.faculty)
    patient = UserRepository(db, clinic.org.id).create("p@x.example.com", "P", PASSWORD, Role.PATIENT)
    db.commit()
    assert client.post("/join/CCC/login", json={"email": clinic.faculty.email, "password": PASSWORD}).status_code == 401  # staff not here
    assert client.post("/join/CCC/login", json={"email": patient.email, "password": PASSWORD}).status_code == 200
