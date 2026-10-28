"""Free phone verification over WhatsApp: the patient sends "JOIN <clinic> <code>"; Meta's signed
webhook proves the sender's number."""

import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.auth import whatsapp
from app.config import get_settings
from app.repositories.users import PhoneOtpRepository

SECRET = "meta-app-secret"


@pytest.fixture
def clinic(db, org_a, monkeypatch):
    org_a.org.join_code, org_a.org.patient_signup_open = "CCC", True
    db.commit()
    monkeypatch.setattr(get_settings(), "whatsapp_number", "+919000000001")
    monkeypatch.setattr(get_settings(), "whatsapp_app_secret", SECRET)
    monkeypatch.setattr(get_settings(), "whatsapp_verify_token", "my-verify-token")
    return org_a


def webhook(client, sender, text, secret=SECRET):
    body = json.dumps({"object": "whatsapp_business_account", "entry": [{"changes": [{"value": {
        "messaging_product": "whatsapp",
        "messages": [{"from": sender, "id": "wamid.x", "timestamp": "0", "type": "text", "text": {"body": text}}],
    }}]}]}).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return client.post("/integrations/whatsapp/webhook", content=body,
                       headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig})


def start(client, phone="98123 45678"):
    r = client.post("/join/CCC/whatsapp", json={"phone": phone})
    assert r.status_code == 200, r.text
    return r.json()


def status(client, ch, phone="98123 45678"):
    return client.post("/join/CCC/whatsapp/status", json={"phone": phone, "challenge_id": ch["challenge_id"]})


def test_new_patient_verifies_by_sending_the_message(client, db, clinic):
    assert client.get("/join/CCC").json()["whatsapp"] is True
    ch = start(client)
    assert ch["message"].startswith("JOIN CCC ") and len(ch["message"].split()[2]) == 6
    assert ch["link"].startswith("https://wa.me/919000000001?text=JOIN%20CCC%20") and ch["to"] == "+919000000001"
    assert status(client, ch).json() == {"waiting": True}
    r = webhook(client, "919812345678", f"Hi! {ch['message']}")  # extra words are fine
    assert r.json() == {"ok": True, "confirmed": 1}
    token = status(client, ch).json()["signup_token"]
    r = client.post("/join/CCC/register", json={"signup_token": token, "full_name": "Asha P", "accept_test_terms": True})
    assert r.status_code == 201 and r.json()["patient_number"].startswith("OR-")
    assert status(client, ch).status_code == 404  # used once only


def test_returning_patient_is_signed_in(client, db, clinic):
    ch = start(client)
    webhook(client, "919812345678", ch["message"])
    token = status(client, ch).json()["signup_token"]
    client.post("/join/CCC/register", json={"signup_token": token, "full_name": "Asha P", "accept_test_terms": True})
    ch = start(client, "+91 98123 45678")
    webhook(client, "919812345678", ch["message"].lower())  # case does not matter
    assert "access_token" in status(client, ch).json()


def test_only_the_number_itself_can_confirm(client, db, clinic):
    ch = start(client)
    assert webhook(client, "919999999999", ch["message"]).json()["confirmed"] == 0  # someone else's WhatsApp
    wrong = ch["message"][:-6] + ("000000" if not ch["message"].endswith("000000") else "111111")
    assert webhook(client, "919812345678", wrong).json()["confirmed"] == 0
    assert webhook(client, "919812345678", ch["message"].replace("CCC", "BBB")).json()["confirmed"] == 0
    assert webhook(client, "919812345678", "hello").json()["confirmed"] == 0
    assert status(client, ch).json() == {"waiting": True}
    assert webhook(client, "919812345678", ch["message"]).json()["confirmed"] == 1


def test_unsigned_or_forged_webhook_calls_are_refused(client, db, clinic):
    ch = start(client)
    assert webhook(client, "919812345678", ch["message"], secret="not-the-secret").status_code == 401
    body = json.dumps({"entry": []}).encode()
    assert client.post("/integrations/whatsapp/webhook", content=body).status_code == 401
    assert status(client, ch).json() == {"waiting": True}


def test_expired_challenge(client, db, clinic):
    ch = start(client)
    row = PhoneOtpRepository(db, clinic.org.id).get(ch["challenge_id"])
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert webhook(client, "919812345678", ch["message"]).json()["confirmed"] == 0
    assert status(client, ch).status_code == 410


def test_a_challenge_belongs_to_its_phone_and_channel(client, db, clinic):
    ch = start(client)
    assert status(client, ch, phone="9812345679").status_code == 404
    sms_code = client.post("/join/CCC/otp", json={"phone": "9812345678"}).json()["demo_code"]
    if sms_code != ch["message"][-6:]:  # (1 in a million they are equal)
        # the SMS code is a different challenge: sending it on WhatsApp confirms nothing
        assert webhook(client, "919812345678", f"JOIN CCC {sms_code}").json()["confirmed"] == 0
    # and the WhatsApp code cannot be typed into the SMS form
    assert client.post("/join/CCC/verify", json={"phone": "9812345678", "code": ch["message"][-6:]}).status_code in (400, 429) \
        or ch["message"][-6:] == sms_code


def test_meta_subscription_check(client, clinic):
    ok = client.get("/integrations/whatsapp/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "my-verify-token", "hub.challenge": "12345"})
    assert ok.status_code == 200 and ok.text == "12345"
    bad = client.get("/integrations/whatsapp/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1"})
    assert bad.status_code == 403


def test_not_offered_until_configured(client, db, org_a, monkeypatch):
    org_a.org.join_code, org_a.org.patient_signup_open = "CCC", True
    db.commit()
    monkeypatch.setattr(get_settings(), "whatsapp_number", "")
    assert client.get("/join/CCC").json()["whatsapp"] is False
    assert client.post("/join/CCC/whatsapp", json={"phone": "9812345678"}).status_code == 404


def test_confirmation_reply_is_free_text_in_the_service_window(client, db, clinic, monkeypatch):
    monkeypatch.setattr(get_settings(), "whatsapp_access_token", "tok")
    monkeypatch.setattr(get_settings(), "whatsapp_phone_number_id", "123")
    sent = {}

    class Reply:
        def raise_for_status(self):
            pass

    monkeypatch.setattr(whatsapp.httpx, "post", lambda url, json, headers, timeout: sent.update(url=url, json=json) or Reply())
    ch = start(client)
    webhook(client, "919812345678", ch["message"])
    assert sent["url"].endswith("/123/messages") and sent["json"]["type"] == "text" and sent["json"]["to"] == "919812345678"
