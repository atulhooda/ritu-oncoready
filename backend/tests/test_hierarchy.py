"""Hospital -> junior doctor -> senior doctor. The hospital adds its doctors; each sent patient goes
to a junior automatically (fewest open patients first); the junior edits the summary and sends it to
a senior. Doctors see only the patients assigned or sent to them."""

from app.models import Role
from tests.test_intake import FACTS, as_user, finished_session, no_background, person  # noqa: F401


def sent_patient(client, db, tenant, name):
    patient = person(db, tenant, Role.PATIENT, name)
    h, _ = finished_session(client, db, tenant, patient)
    assert client.post("/me/publish", headers=h).status_code == 200
    return client.get("/me/profile", headers=h).json()["case_id"]


def add_doctor(client, hh, name, seniority):
    r = client.post("/hospital/doctors", headers=hh, json={
        "full_name": name, "email": f"{name.split()[-1].lower()}@hosp.example.com", "password": "doctor-pass-1",
        "seniority": seniority})
    assert r.status_code == 201, r.text
    return r.json()


def doctor_headers(client, tenant, email):
    r = client.post("/auth/login", json={"org_slug": tenant.org.slug, "email": email, "password": "doctor-pass-1"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_hospital_assigns_junior_writes_and_sends_to_senior(client, db, org_a, org_b):
    hospital = person(db, org_a, Role.HOSPITAL, "City Hospital")
    hh = as_user(client, org_a, hospital)
    junior, other_junior = add_doctor(client, hh, "Dr Jain", "junior"), add_doctor(client, hh, "Dr Kapoor", "junior")
    senior, other_senior = add_doctor(client, hh, "Dr Sen", "senior"), add_doctor(client, hh, "Dr Oberoi", "senior")
    assert client.post("/hospital/doctors", headers=hh, json={**{"full_name": "X Y", "email": "jain@hosp.example.com",
                       "password": "doctor-pass-1", "seniority": "junior"}}).status_code == 409
    assert [d["name"] for d in client.get("/hospital/doctors", headers=hh).json()] == ["Dr Oberoi", "Dr Sen", "Dr Jain", "Dr Kapoor"]
    jh, kh = doctor_headers(client, org_a, junior["email"]), doctor_headers(client, org_a, other_junior["email"])
    sh, oh = doctor_headers(client, org_a, senior["email"]), doctor_headers(client, org_a, other_senior["email"])
    assert client.get("/auth/me", headers=jh).json()["seniority"] == "junior"

    # sent -> straight to a junior: Dr Jain (alphabetical), then Dr Kapoor (fewer open patients)
    case_id = sent_patient(client, db, org_a, "Maria Placeholder")
    second = sent_patient(client, db, org_a, "Bina Placeholder")
    rows = {r["case_id"]: r["review"] for r in client.get("/hospital/patients", headers=hh).json()}
    assert rows[case_id]["status"] == "with_junior" and rows[case_id]["junior"]["name"] == "Dr Jain"
    assert rows[second]["junior"]["name"] == "Dr Kapoor"
    for h in (sh, oh):  # seniors have nothing yet
        assert client.get("/doctor/patients", headers=h).json() == []
        assert client.get(f"/doctor/patients/{case_id}", headers=h).status_code == 404
    assert [d["patients"] for d in client.get("/hospital/doctors", headers=hh).json()] == [0, 0, 1, 1]

    # the hospital can still move one by hand, only to an active junior of its own
    assert client.post(f"/hospital/patients/{case_id}/assign", headers=hh, json={"junior_user_id": senior["id"]}).status_code == 409
    assert client.post(f"/hospital/patients/{case_id}/assign", headers=jh, json={"junior_user_id": junior["id"]}).status_code == 403

    assert [p["case_id"] for p in client.get("/doctor/patients", headers=jh).json()] == [case_id]
    assert [p["case_id"] for p in client.get("/doctor/patients", headers=kh).json()] == [second]
    for h in (kh, sh):
        assert client.get(f"/doctor/patients/{case_id}", headers=h).status_code == 404
    detail = client.get(f"/doctor/patients/{case_id}", headers=jh).json()
    draft = detail["review"]["summary"]
    assert detail["review"]["summary_is_draft"] and "Maria Placeholder" in draft
    assert '"I get out of breath climbing the stairs"' in draft  # the patient's own words, built in code
    assert client.post(f"/doctor/patients/{case_id}/assistant", headers=jh, json={"question": "pulse"}).status_code == 200

    text = draft + "Echo due; ask about ankle swelling."
    assert client.put(f"/doctor/patients/{case_id}/summary", headers=kh, json={"summary": "x"}).status_code == 404
    saved = client.put(f"/doctor/patients/{case_id}/summary", headers=jh, json={"summary": text}).json()
    assert saved["summary"] == text and not saved["summary_is_draft"]
    assert client.get("/doctor/seniors", headers=jh).json() == [{"id": other_senior["id"], "name": "Dr Oberoi"},
                                                                {"id": senior["id"], "name": "Dr Sen"}]

    bad = client.post(f"/doctor/patients/{case_id}/send", headers=jh, json={"senior_user_id": other_junior["id"], "summary": text})
    assert bad.status_code == 409
    sent = client.post(f"/doctor/patients/{case_id}/send", headers=jh, json={"senior_user_id": senior["id"], "summary": text})
    assert sent.status_code == 200 and sent.json()["status"] == "with_senior" and sent.json()["senior"]["name"] == "Dr Sen"

    # the senior gets it (summary first, everything else available); the other senior does not
    inbox = client.get("/doctor/patients", headers=sh).json()
    assert [p["case_id"] for p in inbox] == [case_id] and inbox[0]["review"]["junior"]["name"] == "Dr Jain"
    seen = client.get(f"/doctor/patients/{case_id}", headers=sh).json()
    assert seen["review"]["summary"] == text and len(seen["summary"]["transcript"]) > 0
    assert client.get(f"/doctor/patients/{case_id}", headers=oh).status_code == 404
    # sent: the junior still sees it but can no longer change it; the senior cannot edit it either
    assert client.get(f"/doctor/patients/{case_id}", headers=jh).status_code == 200
    assert client.put(f"/doctor/patients/{case_id}/summary", headers=jh, json={"summary": "late"}).status_code == 409
    assert client.put(f"/doctor/patients/{case_id}/summary", headers=sh, json={"summary": "mine"}).status_code == 409
    assert client.post(f"/hospital/patients/{case_id}/assign", headers=hh, json={"junior_user_id": other_junior["id"]}).status_code == 409

    # another hospital sees none of it
    hb = as_user(client, org_b, person(db, org_b, Role.HOSPITAL, "Far Hospital"))
    assert client.get("/hospital/patients", headers=hb).json() == []
    assert client.get("/hospital/doctors", headers=hb).json() == []
    assert client.post(f"/hospital/patients/{case_id}/assign", headers=hb, json={"junior_user_id": junior["id"]}).status_code == 404
    assert client.patch(f"/hospital/doctors/{junior['id']}", headers=hb, json={"is_active": False}).status_code == 404


def test_patients_wait_for_a_junior_and_move_when_one_leaves(client, db, org_a):
    hh = as_user(client, org_a, person(db, org_a, Role.HOSPITAL, "City Hospital"))
    status = lambda: {r["case_id"]: (r["review"]["status"], (r["review"]["junior"] or {}).get("name"))  # noqa: E731
                      for r in client.get("/hospital/patients", headers=hh).json()}
    case_id = sent_patient(client, db, org_a, "Maria Placeholder")
    assert status()[case_id] == ("unassigned", None)  # no junior yet: it waits
    junior = add_doctor(client, hh, "Dr Jain", "junior")
    assert status()[case_id] == ("with_junior", "Dr Jain")  # picked up when the first junior is added
    add_doctor(client, hh, "Dr Kapoor", "junior")

    r = client.patch(f"/hospital/doctors/{junior['id']}", headers=hh, json={"is_active": False})
    assert r.json()["active"] is False
    assert status()[case_id] == ("with_junior", "Dr Kapoor")  # moved to a junior still here
    assert client.post("/auth/login", json={"org_slug": org_a.org.slug, "email": junior["email"], "password": "doctor-pass-1"}).status_code == 401
    assert client.post(f"/hospital/patients/{case_id}/assign", headers=hh, json={"junior_user_id": junior["id"]}).status_code == 409

    client.patch(f"/hospital/doctors/{junior['id']}", headers=hh, json={"is_active": True, "password": "new-doctor-pass", "seniority": "senior"})
    r = client.post("/auth/login", json={"org_slug": org_a.org.slug, "email": junior["email"], "password": "new-doctor-pass"})
    assert r.status_code == 200
    assert client.post(f"/hospital/patients/{case_id}/assign", headers=hh, json={"junior_user_id": junior["id"]}).status_code == 409  # now senior
    patient = person(db, org_a, Role.PATIENT, "Not Staff")
    assert client.patch(f"/hospital/doctors/{patient.id}", headers=hh, json={"is_active": False}).status_code == 404
    assert client.post("/hospital/doctors", headers=hh, json={"full_name": "Dr Q", "email": "q@hosp.example.com",
                       "password": "doctor-pass-1", "seniority": "chief"}).status_code == 422
