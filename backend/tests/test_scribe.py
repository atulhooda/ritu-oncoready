"""Consultation scribe: the senior doctor records the consultation (or pastes a transcript), the
prescription items the doctor said are extracted with verified quotes, the doctor edits and
approves, and the approved prescription is on the patient's record for doctors and the patient."""

import uuid

import pytest

from app.llm.client import Extraction
from app.models import Role
from app.repositories.cases import CaseRepository
from app.repositories.consultations import ConsultationRepository
from app.repositories.users import UserRepository
from app.scribe import extraction as scribe_extraction, sarvam
from app.scribe.extraction import LlmPrescription, run_scribe
from tests.test_hierarchy import add_doctor, doctor_headers, sent_patient
from tests.test_intake import as_user, no_background, person  # noqa: F401

TYPED = """Doctor: How is the breathlessness since the last cycle?
Patient: Still there when I climb stairs, and my ankles swell.
Doctor: Take furosemide 20 mg once a day in the morning for 5 days.
Doctor: Get a repeat echo this week. Come back after the echo report.
Patient: Okay doctor."""

LLM = {
    "doctor_speaker": 0,
    "medicines": [
        {"name": "Furosemide", "dose": "20 mg", "frequency": "once a day", "duration": "5 days",
         "instructions": "in the morning", "turn_index": 2, "quote": "Take furosemide 20 mg once a day"},
        {"name": "Aspirin", "dose": "75 mg", "turn_index": 2, "quote": "Take aspirin 75 mg daily"},  # never said
    ],
    "tests": [{"text": "Repeat echocardiogram this week", "turn_index": 3, "quote": "Get a repeat echo this week"}],
    "follow_up": [{"text": "After the echo report", "turn_index": 3, "quote": "Come back after the echo report"}],
    "advice": [{"text": "x", "turn_index": 99, "quote": "nothing"}],  # no such turn
}


def fake_extract(data=LLM):
    return lambda text, schema, instructions: Extraction(LlmPrescription.model_validate(data), "fake:scribe")


@pytest.fixture
def senior_setup(client, db, org_a, monkeypatch):
    """Hospital, junior, senior; a sent patient whose summary the junior sent to the senior. The
    background task runs inline with a fake LLM."""
    from app.scribe import tasks

    ran = []

    def inline(org_id, cid):
        run_scribe(db, org_id, cid, transcribe=lambda path: [{"turn_index": 0, "speaker": 0, "text": "Take furosemide 20 mg once a day"}],
                   extract=fake_extract())
        db.commit()
        ran.append(cid)

    monkeypatch.setattr(tasks, "enqueue_consultation", inline)
    hh = as_user(client, org_a, person(db, org_a, Role.HOSPITAL, "City Hospital"))
    junior, senior = add_doctor(client, hh, "Dr Jain", "junior"), add_doctor(client, hh, "Dr Sen", "senior")
    other_senior = add_doctor(client, hh, "Dr Oberoi", "senior")
    case_id = sent_patient(client, db, org_a, "Maria Placeholder")
    jh, sh = doctor_headers(client, org_a, junior["email"]), doctor_headers(client, org_a, senior["email"])
    detail = client.get(f"/doctor/patients/{case_id}", headers=jh).json()
    r = client.post(f"/doctor/patients/{case_id}/send", headers=jh,
                    json={"facts": detail["review"]["content"]["facts"], "points": [], "senior_user_id": senior["id"]})
    assert r.status_code == 200, r.text
    return {"case_id": case_id, "jh": jh, "sh": sh, "hh": hh, "oh": doctor_headers(client, org_a, other_senior["email"]), "ran": ran}


def test_typed_consultation_to_approved_prescription(client, db, org_a, org_b, senior_setup):
    s = senior_setup
    base = f"/doctor/patients/{s['case_id']}/consultations"
    for h in (s["jh"], s["oh"]):  # only the senior it was sent to
        assert client.post(base, headers=h, data={"consent": "true", "transcript": TYPED}).status_code in (403, 404)
    assert client.post(base, headers=s["sh"], data={"consent": "false", "transcript": TYPED}).status_code == 422
    assert client.post(base, headers=s["sh"], data={"consent": "true", "transcript": "no labels here"}).status_code == 422

    r = client.post(base, headers=s["sh"], data={"consent": "true", "transcript": TYPED})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    c = client.get(f"{base}/{cid}", headers=s["sh"]).json()
    assert c["status"] == "draft" and c["rejected"] == 2  # the unsaid aspirin and the missing turn
    assert [t["role"] for t in c["transcript"]] == ["doctor", "patient", "doctor", "doctor", "patient"]
    med = c["report"]["medicines"]
    assert len(med) == 1 and med[0]["name"] == "Furosemide" and med[0]["evidence"]["quote"] == "Take furosemide 20 mg once a day"
    assert c["report"]["tests"][0]["text"] == "Repeat echocardiogram this week" and c["report"]["advice"] == []

    # drafts are the senior's own: the junior, hospital and patient do not see them
    assert client.get(base, headers=s["jh"]).json() == []
    assert client.get(f"{base}/{cid}", headers=s["hh"]).status_code == 404

    # the doctor edits: changes a dose, adds a medicine, tries to attach a made-up quote
    body = {**{k: c["report"][k] for k in ("assessment", "tests", "advice", "follow_up")}, "notes": "Weigh daily.",
            "medicines": [{**med[0], "duration": "7 days"},
                          {"name": "Pantoprazole", "dose": "40 mg", "frequency": "once daily",
                           "evidence": {"turn_index": 1, "quote": "made up"}}]}
    saved = client.put(f"{base}/{cid}/report", headers=s["sh"], json=body).json()
    meds = saved["report"]["medicines"]
    assert meds[0]["duration"] == "7 days" and meds[0]["evidence"] and meds[1]["evidence"] is None
    assert client.put(f"{base}/{cid}/report", headers=s["jh"], json=body).status_code in (403, 404)

    empty = {"assessment": [], "medicines": [], "tests": [], "advice": [], "follow_up": [], "notes": ""}
    assert client.post(f"{base}/{cid}/approve", headers=s["sh"], json=empty).status_code == 422
    final = {k: saved["report"][k] for k in ("assessment", "medicines", "tests", "advice", "follow_up", "notes")}
    ok = client.post(f"{base}/{cid}/approve", headers=s["sh"], json=final)
    assert ok.status_code == 200 and ok.json()["status"] == "approved"
    assert ok.json()["report"]["prescriber"]["name"] == "Dr Sen"
    assert client.put(f"{base}/{cid}/report", headers=s["sh"], json=body).status_code == 409  # read-only now

    # on the record: doctors who can see the patient, and the patient themself
    assert [x["id"] for x in client.get(base, headers=s["jh"]).json()] == [cid]
    assert client.get(f"/prescriptions/{cid}", headers=s["hh"]).status_code == 200
    case = CaseRepository(db, org_a.org.id).get(uuid.UUID(s["case_id"]))
    patient = UserRepository(db, org_a.org.id).get(case.patient_user_id)
    ph = as_user(client, org_a, patient)
    mine = client.get("/me/prescriptions", headers=ph).json()
    assert [m["id"] for m in mine] == [cid] and mine[0]["report"]["medicines"][0]["duration"] == "7 days"
    assert mine[0]["patient"]["name"] == "Maria Placeholder"
    other = as_user(client, org_a, person(db, org_a, Role.PATIENT, "Other Patient"))
    assert client.get(f"/prescriptions/{cid}", headers=other).status_code == 404
    assert client.get(f"/prescriptions/{cid}", headers=s["oh"]).status_code == 404  # a senior it was not sent to
    far = as_user(client, org_b, person(db, org_b, Role.HOSPITAL, "Far Hospital"))
    assert client.get(f"/prescriptions/{cid}", headers=far).status_code == 404


def test_recording_needs_sarvam_and_is_transcribed(client, db, org_a, senior_setup, monkeypatch):
    s = senior_setup
    base = f"/doctor/patients/{s['case_id']}/consultations"
    audio = {"file": ("consult.webm", b"\x1aE\xdf\xa3 fake webm", "audio/webm")}
    monkeypatch.setattr(sarvam, "enabled", lambda: False)
    assert client.post(base, headers=s["sh"], data={"consent": "true"}, files=audio).status_code == 503
    monkeypatch.setattr(sarvam, "enabled", lambda: True)
    bad = {"file": ("x.txt", b"hello", "text/plain")}
    assert client.post(base, headers=s["sh"], data={"consent": "true"}, files=bad).status_code == 415
    r = client.post(base, headers=s["sh"], data={"consent": "true"}, files=audio)
    assert r.status_code == 201, r.text
    c = client.get(f"{base}/{r.json()['id']}", headers=s["sh"]).json()
    assert c["source"] == "recording" and c["has_recording"] and c["status"] == "draft"
    assert c["transcript"][0]["text"] == "Take furosemide 20 mg once a day"
    assert client.get(f"{base}/{c['id']}/recording", headers=s["sh"]).status_code == 200
    assert client.get(f"{base}/{c['id']}/recording", headers=s["jh"]).status_code == 404


def test_failed_processing_can_be_retried(client, db, org_a, senior_setup, monkeypatch):
    from app.scribe import tasks

    s = senior_setup
    monkeypatch.setattr(tasks, "enqueue_consultation", lambda org, cid: None)  # stays processing
    base = f"/doctor/patients/{s['case_id']}/consultations"
    cid = client.post(base, headers=s["sh"], data={"consent": "true", "transcript": TYPED}).json()["id"]
    c = ConsultationRepository(db, org_a.org.id).get(uuid.UUID(cid))
    c.status, c.error = "failed", "Sarvam could not transcribe it"
    db.commit()
    r = client.post(f"{base}/{cid}/retry", headers=s["sh"])
    assert r.status_code == 200 and r.json()["status"] == "processing"


def test_sarvam_result_becomes_turns():
    result = {"transcript": "a b c", "diarized_transcript": {"entries": [
        {"transcript": "Namaste, kya takleef hai?", "speaker_id": "0"},
        {"transcript": "Saans phoolti hai.", "speaker_id": "1"},
        {"transcript": "Aur pair sujte hain.", "speaker_id": "1"},
        {"transcript": " ", "speaker_id": "0"},
        {"transcript": "Furosemide 20 mg lijiye.", "speaker_id": "0"}]}}
    turns = sarvam.turns_from_result(result)
    assert [(t["turn_index"], t["speaker"]) for t in turns] == [(0, 0), (1, 1), (2, 0)]
    assert turns[1]["text"] == "Saans phoolti hai. Aur pair sujte hain."
    assert sarvam.turns_from_result({"transcript": "only text"}) == [{"turn_index": 0, "speaker": None, "text": "only text"}]


def test_doctor_speaker_must_be_a_real_speaker():
    turns = [{"turn_index": 0, "speaker": 0, "text": "Take furosemide 20 mg once a day"}]
    _, _, _, speaker = scribe_extraction.extract_prescription(turns, fake_extract({**LLM, "doctor_speaker": 7}))
    assert speaker is None
