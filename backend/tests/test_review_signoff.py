"""The senior doctor signs off the junior's summary, or returns it with a reason; every change to a
review is kept in an append-only history (who, what, when, the summary as it stood)."""

from app.models import Role
from tests.test_hierarchy import add_doctor, doctor_headers, sent_patient
from tests.test_intake import as_user, no_background, person  # noqa: F401  (autouse: no Celery)


def setup(client, db, org_a):
    hh = as_user(client, org_a, person(db, org_a, Role.HOSPITAL, "City Hospital"))
    junior = add_doctor(client, hh, "Dr Jain", "junior")
    senior, other = add_doctor(client, hh, "Dr Sen", "senior"), add_doctor(client, hh, "Dr Oberoi", "senior")
    case_id = sent_patient(client, db, org_a, "Asha Placeholder")
    jh, sh, oh = (doctor_headers(client, org_a, d["email"]) for d in (junior, senior, other))
    facts = client.get(f"/doctor/patients/{case_id}", headers=jh).json()["review"]["content"]["facts"]
    body = {"facts": facts, "points": [{"kind": "concern", "text": "Fever twice on chemotherapy."}]}
    return case_id, body, senior, jh, sh, oh


def test_senior_signs_off_once_and_the_history_records_every_step(client, db, org_a):
    case_id, body, senior, jh, sh, oh = setup(client, db, org_a)
    assert client.post(f"/doctor/patients/{case_id}/reviewed", headers=sh).status_code == 404  # not sent yet: not theirs
    assert client.put(f"/doctor/patients/{case_id}/summary", headers=jh, json=body).status_code == 200
    assert client.post(f"/doctor/patients/{case_id}/reviewed", headers=jh).status_code == 409  # a junior cannot sign off
    assert client.post(f"/doctor/patients/{case_id}/send", headers=jh, json={**body, "senior_user_id": senior["id"]}).status_code == 200
    assert client.post(f"/doctor/patients/{case_id}/reviewed", headers=oh).status_code == 404  # another senior
    # the junior can still open it once sent, but cannot sign it off or return it
    assert client.post(f"/doctor/patients/{case_id}/reviewed", headers=jh).status_code == 409
    assert client.post(f"/doctor/patients/{case_id}/return", headers=jh, json={"note": "x"}).status_code == 409

    r = client.post(f"/doctor/patients/{case_id}/reviewed", headers=sh)
    assert r.status_code == 200 and r.json()["reviewed_by"]["name"] == "Dr Sen" and r.json()["reviewed_at"]
    assert client.post(f"/doctor/patients/{case_id}/reviewed", headers=sh).status_code == 409  # once
    h = client.get(f"/doctor/patients/{case_id}", headers=jh).json()["review"]["history"]
    assert [(e["action"], e["by"] and e["by"]["name"]) for e in h] == [
        ("assigned", None), ("saved", "Dr Jain"), ("sent", "Dr Jain"), ("reviewed", "Dr Sen")]
    assert "Fever twice on chemotherapy." in h[1]["summary"] and h[-1]["summary"] == h[2]["summary"]


def test_senior_returns_with_a_reason_and_the_junior_sends_again(client, db, org_a):
    case_id, body, senior, jh, sh, oh = setup(client, db, org_a)
    client.post(f"/doctor/patients/{case_id}/send", headers=jh, json={**body, "senior_user_id": senior["id"]})
    client.post(f"/doctor/patients/{case_id}/reviewed", headers=sh)
    for bad in ({"note": ""}, {}):
        assert client.post(f"/doctor/patients/{case_id}/return", headers=sh, json=bad).status_code == 422
    assert client.post(f"/doctor/patients/{case_id}/return", headers=sh, json={"note": "   "}).status_code == 409
    assert client.post(f"/doctor/patients/{case_id}/return", headers=oh, json={"note": "x"}).status_code == 404

    back = client.post(f"/doctor/patients/{case_id}/return", headers=sh, json={"note": "Add the Hb trend."}).json()
    assert back["status"] == "with_junior" and back["senior"] is None and back["reviewed_at"] is None  # sign-off cleared
    assert back["history"][-1]["action"] == "returned" and back["history"][-1]["note"] == "Add the Hb trend."
    assert client.get(f"/doctor/patients/{case_id}", headers=sh).status_code == 404  # back with the junior
    assert client.post(f"/doctor/patients/{case_id}/return", headers=sh, json={"note": "again"}).status_code == 404

    edited = {**body, "points": body["points"] + [{"kind": "finding", "text": "Hb 11.2 to 9.8 g/dL."}]}
    assert client.post(f"/doctor/patients/{case_id}/send", headers=jh, json={**edited, "senior_user_id": senior["id"]}).status_code == 200
    h = client.get(f"/doctor/patients/{case_id}", headers=sh).json()["review"]["history"]
    assert [e["action"] for e in h] == ["assigned", "sent", "reviewed", "returned", "sent"]
    assert "Hb 11.2 to 9.8 g/dL." in h[-1]["summary"] and "Hb 11.2" not in h[1]["summary"]  # each version kept


def test_review_events_are_scoped_and_append_only(db, org_a, org_b):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.repositories.reviews import ReviewEventRepository
    from tests.test_tenant_isolation import make_case

    case, *_ = make_case(db, org_a)
    e = ReviewEventRepository(db, org_a.org.id).add(case_id=case.id, actor_user_id=None, action="assigned")
    assert ReviewEventRepository(db, org_b.org.id).get(e.id) is None
    assert ReviewEventRepository(db, org_b.org.id).for_case(case.id) == []
    with pytest.raises(IntegrityError):  # a return must carry its reason, even outside the API
        with db.begin_nested():
            ReviewEventRepository(db, org_a.org.id).add(case_id=case.id, actor_user_id=None, action="returned", note=" ")
