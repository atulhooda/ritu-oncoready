"""Patient -> Ritu session -> summary -> doctor. Fake LLM, no Ritu server, no Celery."""

import io
import json
import time

import pytest
from PIL import Image

from app.config import get_settings
from app.intake.extraction import LlmFacts, run_intake_extraction
from app.llm.client import Extraction
from app.models import Role
from app.repositories.intake import IntakeFactRepository, IntakeSessionRepository
from app.repositories.users import UserRepository
from app.voice import client as ritu
from tests.conftest import PASSWORD, login
from tests.test_tenant_isolation import make_case

TURNS = [
    {"role": "ritu", "text": "What problems or symptoms are you having right now?"},
    {"role": "patient", "text": "I get out of breath climbing the stairs, for about two weeks now."},
    {"role": "ritu", "text": "Is there anything else you are feeling?"},
    {"role": "patient", "text": "My ankles are swollen in the evening. I take trastuzumab every three weeks."},
    {"role": "ritu", "text": "Do you have any earlier medical records?"},
    {"role": "patient", "text": "Yes, three echo reports from Heart Associates and my biopsy report."},
]
FACTS = [
    {"section": "current_symptom", "label": "Breathlessness on stairs", "turn_index": 1,
     "quote": "I get out of breath climbing the stairs", "details": {"duration": "about two weeks"}},
    {"section": "current_symptom", "label": "Evening ankle swelling", "turn_index": 3, "quote": "My ankles are swollen in the evening"},
    {"section": "medication", "label": "Trastuzumab every 3 weeks", "turn_index": 3, "quote": "I take trastuzumab every three weeks"},
    {"section": "previous_record", "label": "Echo reports (x3)", "turn_index": 5,
     "quote": "three echo reports from Heart Associates", "details": {"facility": "Heart Associates"}},
    # rejected:
    {"section": "current_symptom", "label": "From Ritu's turn", "turn_index": 0, "quote": "What problems or symptoms"},
    {"section": "current_symptom", "label": "Not said", "turn_index": 1, "quote": "I have crushing chest pain at night"},
    {"section": "diagnosis", "label": "Cardiotoxicity", "turn_index": 1, "quote": "out of breath"},
]


def fake_llm(facts):
    return lambda text, schema, instructions: Extraction(LlmFacts(facts=facts), "fake:intake")


@pytest.fixture(autouse=True)
def no_background(monkeypatch):
    from app.intake import tasks as intake_tasks
    from app.pipeline import tasks as pipeline_tasks

    queued = {"summaries": [], "documents": []}
    monkeypatch.setattr(intake_tasks, "enqueue_summary", lambda org, sid: queued["summaries"].append(sid))
    monkeypatch.setattr(pipeline_tasks, "enqueue_document", lambda org, doc, case: queued["documents"].append(doc))
    monkeypatch.setattr(get_settings(), "ritu_base_url", "")
    monkeypatch.setattr(get_settings(), "ritu_shared_secret", "test-secret")
    return queued


def person(db, tenant, role, name):
    slug = name.lower().replace(" ", "")
    return UserRepository(db, tenant.org.id).create(f"{slug}@{tenant.org.slug}.example.com", name, PASSWORD, role)


def as_user(client, tenant, user):
    return login(client, tenant, user)


def finished_session(client, db, tenant, patient, facts=FACTS):
    h = as_user(client, tenant, patient)
    s = client.post("/me/sessions", headers=h).json()
    assert s["mode"] == "simulator" and s["status"] == "in_progress"
    r = client.post(f"/me/sessions/{s['id']}/simulate", headers=h, json={"turns": TURNS})
    assert r.status_code == 200 and r.json()["status"] == "completed"
    run_intake_extraction(db, tenant.org.id, s["id"], extract=fake_llm(facts))
    return h, s["id"]


def test_patient_session_to_doctor(client, db, org_a, no_background):
    patient = person(db, org_a, Role.PATIENT, "Maria Placeholder")
    doctor = person(db, org_a, Role.DOCTOR, "Doctor Rao")
    h, sid = finished_session(client, db, org_a, patient)
    assert [str(x) for x in no_background["summaries"]] == [sid]

    prof = client.get("/me/profile", headers=h).json()
    assert prof["voice_mode"] == "simulator" and prof["published_at"] is None
    sections = {s["section"]: s for s in prof["summary"]["sections"]}
    assert [f["label"] for f in sections["current_symptom"]["facts"]] == ["Breathlessness on stairs", "Evening ankle swelling"]
    assert sections["medication"]["facts"][0]["quote"] == "I take trastuzumab every three weeks"
    assert sections["previous_record"]["facts"][0]["details"] == {"facility": "Heart Associates"}
    assert [s["section"] for s in prof["summary"]["sections"]] == [
        "current_symptom", "medication", "allergy", "past_history", "previous_record"]

    session = IntakeSessionRepository(db, org_a.org.id).get(sid)
    assert sorted(r["reason"] for r in session.rejected_facts) == ["invalid_candidate", "not_a_patient_turn", "quote_not_in_turn"]
    for f in IntakeFactRepository(db, org_a.org.id).for_session(sid):  # every fact is the patient's own words
        assert f.source_text_span in next(t["text"] for t in TURNS if f.source_text_span in t["text"])

    doc_h = as_user(client, org_a, doctor)
    assert client.get("/doctor/patients", headers=doc_h).json() == []
    assert client.get(f"/doctor/patients/{prof['case_id']}", headers=doc_h).status_code == 404  # not sent yet

    assert client.post("/me/publish", headers=h).status_code == 200
    listed = client.get("/doctor/patients", headers=doc_h).json()
    assert [p["name"] for p in listed] == ["Maria Placeholder"]
    assert listed[0]["symptoms"] == ["Breathlessness on stairs", "Evening ankle swelling"]
    detail = client.get(f"/doctor/patients/{prof['case_id']}", headers=doc_h).json()
    assert len(detail["summary"]["transcript"]) == len(TURNS) and "timeline" in detail


def test_publish_requires_a_summarized_session(client, db, org_a):
    patient = person(db, org_a, Role.PATIENT, "New Patient")
    h = as_user(client, org_a, patient)
    assert client.post("/me/publish", headers=h).status_code == 409
    s = client.post("/me/sessions", headers=h).json()
    client.post(f"/me/sessions/{s['id']}/simulate", headers=h, json={"turns": TURNS})
    assert client.post("/me/publish", headers=h).status_code == 409  # transcript in, not summarized yet


def test_simulated_transcript_rules(client, db, org_a):
    patient = person(db, org_a, Role.PATIENT, "Sim Patient")
    h = as_user(client, org_a, patient)
    s = client.post("/me/sessions", headers=h).json()
    url = f"/me/sessions/{s['id']}/simulate"
    assert client.post(url, headers=h, json={"turns": [{"role": "ritu", "text": "Hello?"}]}).status_code == 422
    assert client.post(url, headers=h, json={"turns": [{"role": "system", "text": "x"}]}).status_code == 422
    assert client.post(url, headers=h, json={"turns": TURNS}).status_code == 200
    assert client.post(url, headers=h, json={"turns": TURNS}).json()["status"] == "completed"  # idempotent


def test_ritu_mode_returns_browser_connection(client, db, org_a, monkeypatch):
    monkeypatch.setattr(ritu, "enabled", lambda: True)
    monkeypatch.setattr(ritu, "create_browser_session", lambda org, sid, name, lang: ritu.BrowserSession(
        "rs_1", "wss://ritu.example/media-stream?sample-rate=8000", "tok_1", None))
    patient = person(db, org_a, Role.PATIENT, "Voice Patient")
    h = as_user(client, org_a, patient)
    s = client.post("/me/sessions", headers=h).json()
    assert s["mode"] == "ritu" and s["ritu"]["token"] == "tok_1"
    assert client.post(f"/me/sessions/{s['id']}/simulate", headers=h, json={"turns": TURNS}).status_code == 409

    def down(*a):
        raise ritu.RituError("connection refused")

    monkeypatch.setattr(ritu, "create_browser_session", down)
    assert client.post("/me/sessions", headers=h).status_code == 502


# --- Ritu callback ---------------------------------------------------------------------


def post_callback(client, payload, secret="test-secret", ts=None):
    body = json.dumps(payload).encode()
    ts = ts or str(int(time.time()))
    sig = ritu.sign(ts, body, secret)
    return client.post("/integrations/ritu/sessions", content=body,
                       headers={"Content-Type": "application/json", "X-Ritu-Timestamp": ts, "X-Ritu-Signature": sig})


def test_ritu_callback_records_transcript(client, db, org_a, monkeypatch, no_background):
    monkeypatch.setattr(ritu, "enabled", lambda: True)
    monkeypatch.setattr(ritu, "create_browser_session", lambda *a: ritu.BrowserSession("rs_9", "wss://x", "t", None))
    patient = person(db, org_a, Role.PATIENT, "Callback Patient")
    s = client.post("/me/sessions", headers=as_user(client, org_a, patient)).json()
    payload = {"session_id": "rs_9", "external_ref": ritu.external_ref(org_a.org.id, s["id"]), "status": "completed",
               "transcript": [{"role": t["role"], "text": t["text"]} for t in TURNS]}

    assert post_callback(client, payload, secret="wrong").status_code == 401
    assert post_callback(client, payload, ts=str(int(time.time()) - 3600)).status_code == 401  # replay window
    assert post_callback(client, payload | {"session_id": "rs_other"}).status_code == 404
    assert post_callback(client, payload).status_code == 200
    assert post_callback(client, payload).status_code == 200  # retried delivery: no duplicate turns
    assert IntakeSessionRepository(db, org_a.org.id).get(s["id"]).status == "completed"
    assert [str(x) for x in no_background["summaries"]] == [s["id"]]


def test_ritu_callback_failure_status(client, db, org_a, monkeypatch):
    monkeypatch.setattr(ritu, "enabled", lambda: True)
    monkeypatch.setattr(ritu, "create_browser_session", lambda *a: ritu.BrowserSession("rs_5", "wss://x", "t", None))
    patient = person(db, org_a, Role.PATIENT, "Dropped Patient")
    s = client.post("/me/sessions", headers=as_user(client, org_a, patient)).json()
    payload = {"session_id": "rs_5", "external_ref": ritu.external_ref(org_a.org.id, s["id"]), "status": "no_input"}
    assert post_callback(client, payload).status_code == 200
    assert IntakeSessionRepository(db, org_a.org.id).get(s["id"]).status == "failed"


# --- who sees what ---------------------------------------------------------------------


def test_case_visibility_by_role(client, db, org_a, org_b):
    training, _, _ = make_case(db, org_a)
    p1, p2 = person(db, org_a, Role.PATIENT, "Patient One"), person(db, org_a, Role.PATIENT, "Patient Two")
    doctor, doctor_b = person(db, org_a, Role.DOCTOR, "Doctor A"), person(db, org_b, Role.DOCTOR, "Doctor B")
    h1, _ = finished_session(client, db, org_a, p1)
    h2 = as_user(client, org_a, p2)
    case1 = client.get("/me/profile", headers=h1).json()["case_id"]
    client.get("/me/profile", headers=h2)  # creates patient two's own case

    # Patients: only their own intake case; never training cases or each other.
    assert [c["id"] for c in client.get("/cases", headers=h1).json()] == [case1]
    assert client.get(f"/cases/{training.id}", headers=h1).status_code == 404
    assert client.get(f"/cases/{case1}", headers=h2).status_code == 404
    assert client.get(f"/cases/{case1}/timeline", headers=h2).status_code == 404

    # Training roles never see intake cases.
    for u in (org_a.resident, org_a.faculty, org_a.admin):
        h = as_user(client, org_a, u)
        assert case1 not in {c["id"] for c in client.get("/cases", headers=h).json()}
        assert client.get(f"/cases/{case1}", headers=h).status_code == 404
        assert client.get(f"/cases/{case1}/timeline", headers=h).status_code == 404
    assert client.get(f"/cases/{case1}/brief", headers=as_user(client, org_a, org_a.resident)).status_code == 404

    # Doctors: only after publish, never training cases, never another org.
    hd = as_user(client, org_a, doctor)
    assert client.get(f"/cases/{case1}", headers=hd).status_code == 404
    client.post("/me/publish", headers=h1)
    assert client.get(f"/cases/{case1}", headers=hd).status_code == 200
    assert client.get(f"/cases/{case1}/timeline", headers=hd).status_code == 200
    assert client.get(f"/cases/{training.id}", headers=hd).status_code == 404
    hb = as_user(client, org_b, doctor_b)
    assert client.get("/doctor/patients", headers=hb).json() == []
    assert client.get(f"/doctor/patients/{case1}", headers=hb).status_code == 404

    # Role gates on the new routers.
    assert client.get("/me/profile", headers=hd).status_code == 403
    assert client.get("/doctor/patients", headers=h1).status_code == 403
    assert client.get("/doctor/patients", headers=as_user(client, org_a, org_a.faculty)).status_code == 403


def test_patient_cannot_touch_another_patients_session(client, db, org_a):
    p1, p2 = person(db, org_a, Role.PATIENT, "Owner Patient"), person(db, org_a, Role.PATIENT, "Other Patient")
    s = client.post("/me/sessions", headers=as_user(client, org_a, p1)).json()
    h2 = as_user(client, org_a, p2)
    assert client.get(f"/me/sessions/{s['id']}", headers=h2).status_code == 404
    assert client.post(f"/me/sessions/{s['id']}/simulate", headers=h2, json={"turns": TURNS}).status_code == 404


def test_record_upload_types(client, db, org_a, no_background):
    patient = person(db, org_a, Role.PATIENT, "Upload Patient")
    h = as_user(client, org_a, patient)
    buf = io.BytesIO()
    Image.new("RGB", (40, 40), "white").save(buf, "PNG")
    r = client.post("/me/records", headers=h, files={"file": ("echo.png", buf.getvalue(), "image/png")})
    assert r.status_code == 202
    assert [str(d) for d in no_background["documents"]] == [r.json()["id"]]  # OCR pipeline enqueued
    assert client.post("/me/records", headers=h, files={"file": ("x.txt", b"hello", "text/plain")}).status_code == 415
    assert [rec["filename"] for rec in client.get("/me/profile", headers=h).json()["records"]] == ["echo.png"]


def test_pipeline_rasterizes_images(tmp_path):
    from app.pipeline.ocr import rasterize

    path = tmp_path / "scan.jpg"
    Image.new("RGB", (300, 200), "white").save(path, "JPEG")
    assert len(rasterize(path, 72)) == 1


# --- patient details -------------------------------------------------------------------

DETAILS = {
    "date_of_birth": "1971-09-30", "sex": "female", "phone": "+91 98200 11111", "preferred_language": "hi-IN",
    "cancer_type": "Breast cancer", "diagnosed_on": "2025-02-01", "stage_reported": "Stage 2",
    "treatment_status": "on_treatment", "current_treatment": "Trastuzumab every 3 weeks (on hold)",
    "treating_hospital": "Synthetic General Hospital", "treating_doctor": "", "other_conditions": None,
}


def test_patient_details_roundtrip_and_validation(client, db, org_a):
    patient = person(db, org_a, Role.PATIENT, "Detail Patient")
    h = as_user(client, org_a, patient)
    blank = client.get("/me/profile", headers=h).json()["details"]
    assert blank["preferred_language"] == "en-IN" and blank["age"] is None and blank["cancer_type"] is None

    saved = client.put("/me/details", headers=h, json=DETAILS).json()
    assert saved["sex"] == "female" and saved["cancer_type"] == "Breast cancer"
    assert saved["treating_doctor"] is None  # blank -> empty
    assert isinstance(saved["age"], int) and saved["age"] >= 54
    assert client.get("/me/profile", headers=h).json()["details"]["preferred_language"] == "hi-IN"

    for bad in ({"sex": "robot"}, {"preferred_language": "fr-FR"}, {"date_of_birth": "2999-01-01"},
                {"treatment_status": "cured"}, {"phone": "call me"}, {"unknown_field": "x"}):
        assert client.put("/me/details", headers=h, json=DETAILS | bad).status_code == 422, bad


def test_session_uses_preferred_language(client, db, org_a, monkeypatch):
    seen = {}

    def fake_create(org, sid, name, lang):
        seen["lang"] = lang
        return ritu.BrowserSession("rs_l", "wss://x", "t", None)

    monkeypatch.setattr(ritu, "enabled", lambda: True)
    monkeypatch.setattr(ritu, "create_browser_session", fake_create)
    patient = person(db, org_a, Role.PATIENT, "Language Patient")
    h = as_user(client, org_a, patient)
    client.put("/me/details", headers=h, json=DETAILS)
    assert client.post("/me/sessions", headers=h).json()["language"] == "hi-IN"
    assert seen["lang"] == "hi-IN"


def test_doctor_sees_details_only_after_send(client, db, org_a, org_b):
    patient = person(db, org_a, Role.PATIENT, "Shared Patient")
    other = person(db, org_a, Role.PATIENT, "Other Patient")
    doctor, doctor_b = person(db, org_a, Role.DOCTOR, "Doctor Shah"), person(db, org_b, Role.DOCTOR, "Doctor Far")
    h, _ = finished_session(client, db, org_a, patient)
    client.put("/me/details", headers=h, json=DETAILS)
    case_id = client.get("/me/profile", headers=h).json()["case_id"]
    hd = as_user(client, org_a, doctor)

    assert client.get(f"/doctor/patients/{case_id}", headers=hd).status_code == 404
    client.post("/me/publish", headers=h)
    row = client.get("/doctor/patients", headers=hd).json()[0]
    assert (row["sex"], row["cancer_type"]) == ("female", "Breast cancer") and row["age"] >= 54
    detail = client.get(f"/doctor/patients/{case_id}", headers=hd).json()
    assert detail["details"]["treating_hospital"] == "Synthetic General Hospital"

    # Another patient only ever sees their own (blank) details; another org sees nothing.
    assert client.get("/me/profile", headers=as_user(client, org_a, other)).json()["details"]["cancer_type"] is None
    assert client.get(f"/doctor/patients/{case_id}", headers=as_user(client, org_b, doctor_b)).status_code == 404


def test_browser_session_request_carries_the_calm_voice(monkeypatch):
    sent = {}

    class Resp:
        status_code = 201

        def raise_for_status(self):
            pass

        def json(self):
            return {"session_id": "rs_1", "ws_url": "wss://x", "token": "t", "expires_at": None}

    def fake_post(url, content, headers, timeout):
        sent["body"] = json.loads(content)
        sent["headers"] = headers
        return Resp()

    monkeypatch.setattr(get_settings(), "ritu_base_url", "http://ritu.test")
    monkeypatch.setattr(ritu.httpx, "post", fake_post)
    ritu.create_browser_session("org", "sess", "Maria", "hi-IN")
    assert sent["body"]["voice"] == {"speaker": "roopa", "pace": 1.0, "temperature": 0.45}
    assert sent["body"]["language"] == "hi-IN"
    ts, sig = sent["headers"]["X-Ritu-Timestamp"], sent["headers"]["X-Ritu-Signature"]
    assert ritu.verify(ts, sig, json.dumps(sent["body"]).encode())


def test_doctor_sees_every_conversation(client, db, org_a):
    """A later 'nothing new' conversation must not hide what the patient said earlier."""
    patient = person(db, org_a, Role.PATIENT, "Repeat Patient")
    doctor = person(db, org_a, Role.DOCTOR, "Doctor Iyer")
    h, first = finished_session(client, db, org_a, patient)
    quiet = [{"role": "ritu", "text": "Any problems today?"}, {"role": "patient", "text": "No, nothing new today."}]
    s2 = client.post("/me/sessions", headers=h).json()
    client.post(f"/me/sessions/{s2['id']}/simulate", headers=h, json={"turns": quiet})
    run_intake_extraction(db, org_a.org.id, s2["id"], extract=fake_llm([]))
    client.post("/me/publish", headers=h)

    hd = as_user(client, org_a, doctor)
    row = client.get("/doctor/patients", headers=hd).json()[0]
    assert row["conversations"] == 2
    assert row["symptoms"] == ["Breathlessness on stairs", "Evening ankle swelling"]
    detail = client.get(f"/doctor/patients/{row['case_id']}", headers=hd).json()
    assert [str(s["session_id"]) for s in detail["sessions"]] == [s2["id"], first]  # newest first
    assert sum(len(sec["facts"]) for sec in detail["sessions"][0]["sections"]) == 0
    assert sum(len(sec["facts"]) for sec in detail["sessions"][1]["sections"]) == 4
