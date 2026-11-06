"""The doctor asks the patient for a record or a question; the patient answers from their page."""

from app.models import Role
from tests.test_hierarchy import add_doctor, doctor_headers, sent_patient
from tests.test_intake import _jpeg, as_user, no_background, person  # noqa: F401  (autouse: no Celery)


def test_doctor_asks_and_the_patient_answers_both_kinds(client, db, org_a, org_b):
    hh = as_user(client, org_a, person(db, org_a, Role.HOSPITAL, "City Hospital"))
    junior, other = add_doctor(client, hh, "Dr Jain", "junior"), add_doctor(client, hh, "Dr Kapoor", "junior")
    case_id = sent_patient(client, db, org_a, "Asha Placeholder")
    jh, kh = doctor_headers(client, org_a, junior["email"]), doctor_headers(client, org_a, other["email"])
    from app.repositories.users import UserRepository

    ph = as_user(client, org_a, UserRepository(db, org_a.org.id).get_by_email("ashaplaceholder@org-a.example.com"))
    url = f"/doctor/patients/{case_id}/requests"

    assert client.post(url, headers=kh, json={"kind": "record", "text": "PET-CT"}).status_code == 404  # not their patient
    for bad in ({"kind": "record", "text": ""}, {"kind": "advice", "text": "x"}, {"text": "x"}):
        assert client.post(url, headers=jh, json=bad).status_code == 422
    assert client.post(url, headers=jh, json={"kind": "question", "text": "   "}).status_code == 409
    client.post(url, headers=jh, json={"kind": "record", "text": "PET-CT report from City Imaging Centre (September)"})
    asked = client.post(url, headers=jh, json={"kind": "question", "text": "How many days did the fever last?"}).json()
    assert [(r["kind"], r["status"], r["asked_by"]["name"]) for r in asked] == [("question", "open", "Dr Jain"), ("record", "open", "Dr Jain")]
    q, rec = asked[0]["id"], asked[1]["id"]

    mine = client.get("/me/requests", headers=ph).json()
    assert [r["text"] for r in mine] == ["How many days did the fever last?", "PET-CT report from City Imaging Centre (September)"]
    assert client.post(f"/me/requests/{q}/record", headers=ph, json={"document_id": rec}).status_code in (404, 409)
    assert client.post(f"/me/requests/{rec}/answer", headers=ph, json={"text": "x"}).status_code == 409  # wants a record
    assert client.post(f"/me/requests/{q}/answer", headers=ph, json={"text": "  "}).status_code == 409
    a = client.post(f"/me/requests/{q}/answer", headers=ph, json={"text": "Two days, around 100."}).json()
    assert (a["status"], a["answer"]) == ("answered", "Two days, around 100.") and a["answered_at"]
    assert [r["status"] for r in client.get("/me/requests", headers=ph).json()] == ["open", "answered"]  # open ones first

    # a record that is not this patient's cannot be the answer
    bina = as_user(client, org_a, person(db, org_a, Role.PATIENT, "Bina Placeholder"))
    theirs = client.post("/me/records", headers=bina, files={"file": ("b.jpg", _jpeg(), "image/jpeg")}).json()
    assert client.post(f"/me/requests/{rec}/record", headers=ph, json={"document_id": theirs["id"]}).status_code == 404

    doc = client.post("/me/records", headers=ph, files={"file": ("pet.jpg", _jpeg(), "image/jpeg")}).json()
    linked = client.post(f"/me/requests/{rec}/record", headers=ph, json={"document_id": doc["id"]}).json()
    assert linked["status"] == "answered" and linked["document"]["id"] == doc["id"]
    seen = client.get(f"/doctor/patients/{case_id}", headers=jh).json()["requests"]
    assert {r["kind"]: r["status"] for r in seen} == {"record": "answered", "question": "answered"}

    # removing that record keeps the request answered, without the link
    assert client.delete(f"/me/records/{doc['id']}", headers=ph).status_code == 204
    after = {r["kind"]: r for r in client.get("/me/requests", headers=ph).json()}
    assert after["record"]["status"] == "answered" and after["record"]["document"] is None

    # another patient, and another hospital, see none of it
    other_patient = bina
    assert client.get("/me/requests", headers=other_patient).json() == []
    assert client.post(f"/me/requests/{q}/answer", headers=other_patient, json={"text": "x"}).status_code == 404
    ob = as_user(client, org_b, person(db, org_b, Role.PATIENT, "Far Patient"))
    assert client.get("/me/requests", headers=ob).json() == []


def test_patient_requests_are_scoped(db, org_a, org_b):
    from app.repositories.requests import PatientRequestRepository
    from tests.test_tenant_isolation import make_case

    case, *_ = make_case(db, org_a)
    r = PatientRequestRepository(db, org_a.org.id).add(case_id=case.id, requested_by=org_a.faculty.id, kind="question", text="x")
    assert PatientRequestRepository(db, org_b.org.id).get(r.id) is None
    assert PatientRequestRepository(db, org_b.org.id).for_case(case.id) == []
