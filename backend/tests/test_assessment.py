"""Resident assessment loop: brief -> LLM matching (verified quotes) -> deterministic score ->
faculty overrides. Fake LLM; no network."""

import random
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app.llm.client import Extraction
from app.models import Role
from app.repositories.scoring import (
    AnswerKeyRepository,
    BriefItemMatchRepository,
    ReadinessBriefRepository,
    RubricItemRepository,
    ScoreRepository,
)
from app.repositories.users import UserRepository
from app.scoring import tasks
from app.scoring.engine import ENGINE_VERSION, MatchInput, RubricItemInput, score
from app.scoring.matching import LlmMatches, run_matching
from app.scoring.service import compute_score, match_and_score
from tests.conftest import PASSWORD, login
from tests.test_tenant_isolation import make_case

RUBRIC = [  # (category, description, weight, is_critical)
    ("pending_tests", "Identifies HER2 FISH as outstanding", 3, True),
    ("pathology", "States histology and grade", 2, False),
    ("pathology", "States receptor status", 2, False),
    ("discrepancies", "Notes imaging size discrepancy", 1, False),
]
BRIEF = {
    "key_changes": "New left breast mass, biopsy shows invasive ductal carcinoma, grade 2.",
    "pending_investigations": "HER2 FISH   was sent and is still pending.",
    "discrepancies_noticed": "",
    "treatment_history": "None yet.",
    "red_flags": "ER and PR positive.",
}
GOOD_MATCHES = [
    {"rubric_item_id": "R1", "section": "pending_investigations", "quote": "HER2 FISH was sent and is still pending"},
    {"rubric_item_id": "R2", "section": "key_changes", "quote": "invasive ductal carcinoma, grade 2"},
    {"rubric_item_id": "R3", "section": "red_flags", "quote": "ER and PR positive"},
]


@pytest.fixture(autouse=True)
def no_celery(monkeypatch):
    queued = []
    monkeypatch.setattr(tasks, "enqueue_scoring", lambda org_id, brief_id: queued.append(brief_id))
    return queued


def fake_llm(matches):
    return lambda text, schema, instructions: Extraction(LlmMatches(matches=matches), "fake:matcher")


def add_answer_key(db, tenant, case, rubric=RUBRIC):
    key = AnswerKeyRepository(db, tenant.org.id).add(case_id=case.id, status="final",
                                                      authored_by_user_id=tenant.faculty.id)
    return [
        RubricItemRepository(db, tenant.org.id).add(answer_key_id=key.id, position=n, category=c, description=d,
                                                    weight=w, is_critical=crit)
        for n, (c, d, w, crit) in enumerate(rubric)
    ]


def submitted_brief(db, tenant, case, resident=None, content=BRIEF):
    return ReadinessBriefRepository(db, tenant.org.id).add(
        case_id=case.id, author_user_id=(resident or tenant.resident).id, content=content, status="submitted",
        submitted_at=datetime.now(UTC),
    )


def scored_case(db, tenant, code="SYN-001", matches=GOOD_MATCHES, resident=None):
    case, _, _ = make_case(db, tenant, code)
    items = add_answer_key(db, tenant, case)
    brief = submitted_brief(db, tenant, case, resident)
    s = match_and_score(db, tenant.org.id, brief.id, extract=fake_llm(matches))
    return case, items, brief, s


# --- determinism -----------------------------------------------------------------------


def test_engine_is_deterministic_and_order_independent():
    items = [RubricItemInput(f"i{n}", n, c, d, Decimal(w), crit) for n, (c, d, w, crit) in enumerate(RUBRIC)]
    matches = [MatchInput("i0", True, "q"), MatchInput("i1", False), MatchInput("i3", True, "q2")]
    first = score(items, matches)
    for seed in range(5):
        shuffled_items, shuffled_matches = items[:], matches[:]
        random.Random(seed).shuffle(shuffled_items)
        random.Random(seed).shuffle(shuffled_matches)
        again = score(shuffled_items, shuffled_matches)
        assert (again.points_earned, again.points_possible, again.critical_missed, again.details) == (
            first.points_earned, first.points_possible, first.critical_missed, first.details)
    assert (first.points_earned, first.points_possible, first.critical_missed) == (Decimal(4), Decimal(8), 0)
    assert first.details["engine_version"] == ENGINE_VERSION and first.details["percent"] == "50.00"


def test_rescoring_same_inputs_gives_same_stored_score(db, org_a):
    _, _, brief, s = scored_case(db, org_a)
    snapshot = (s.id, s.points_earned, s.critical_missed, s.details)
    s2 = compute_score(db, org_a.org.id, brief.id)
    assert (s2.id, s2.points_earned, s2.critical_missed, s2.details) == snapshot
    assert len(ScoreRepository(db, org_a.org.id).for_brief(brief.id)) == 1


def test_score_breakdown(db, org_a):
    _, items, _, s = scored_case(db, org_a)
    assert (s.points_earned, s.points_possible, s.critical_missed) == (Decimal("7.00"), Decimal("8.00"), 0)
    rows = {r["rubric_item_id"]: r for r in s.details["items"]}
    assert rows[str(items[0].id)]["evidence"] == "HER2 FISH   was sent and is still pending"  # verbatim brief text
    assert rows[str(items[3].id)]["matched"] is False and rows[str(items[3].id)]["source"] == "matcher"
    assert s.details["by_category"]["discrepancies"]["missed"] == 1


# --- matching validation ---------------------------------------------------------------


def test_quote_must_appear_in_brief(db, org_a):
    case, _, _ = make_case(db, org_a)
    items = add_answer_key(db, org_a, case)
    brief = submitted_brief(db, org_a, case)
    summary = run_matching(db, org_a.org.id, brief.id, extract=fake_llm([
        {"rubric_item_id": "R1", "quote": "HER2 FISH result is pending"},  # paraphrase: rejected
        {"rubric_item_id": "R4", "quote": "mammogram and ultrasound sizes differ"},  # not in brief
        {"rubric_item_id": "R9", "quote": "ER and PR positive"},  # unknown item
        {"rubric_item_id": "R2"},  # malformed
        {"rubric_item_id": "R3", "quote": "ER and PR positive"},
    ]))
    assert (summary.matched, summary.rejected, summary.unknown_items) == (1, 4, ["R9"])
    rows = {m.rubric_item_id: m for m in BriefItemMatchRepository(db, org_a.org.id).for_brief(brief.id)}
    assert rows[items[0].id].matched is False
    assert rows[items[0].id].rejected_evidence[0]["reason"] == "quote_not_in_brief"
    assert rows[items[2].id].matched is True and rows[items[2].id].evidence_section == "red_flags"
    assert compute_score(db, org_a.org.id, brief.id).critical_missed == 1


# --- overrides -------------------------------------------------------------------------


def override(client, headers, brief, item, **body):
    return client.put(f"/faculty/briefs/{brief.id}/items/{item.id}/override", headers=headers, json=body)


def test_overrides_recompute_score(client, db, org_a):
    _, items, brief, _ = scored_case(db, org_a, matches=GOOD_MATCHES[1:])  # critical R1 missed
    fac = login(client, org_a, org_a.faculty)
    detail = client.get(f"/faculty/briefs/{brief.id}", headers=fac).json()
    assert (detail["score"]["points_earned"], detail["score"]["critical_missed"]) == ("4.00", 1)

    r = override(client, fac, brief, items[0], matched=True, comment="FISH pending is stated",
                 evidence_quote="HER2 FISH was sent and is still pending")
    assert r.status_code == 200
    assert (r.json()["score"]["points_earned"], r.json()["score"]["critical_missed"]) == ("7.00", 0)
    row = next(i for i in r.json()["items"] if i["rubric_item_id"] == str(items[0].id))
    assert (row["source"], row["override_comment"], row["matcher_matched"]) == ("override", "FISH pending is stated", False)
    assert row["overridden_by"] == "Faculty"

    r = override(client, fac, brief, items[1], matched=False, comment="Grade not stated as required")
    assert r.json()["score"]["points_earned"] == "5.00"

    r = client.delete(f"/faculty/briefs/{brief.id}/items/{items[0].id}/override", headers=fac)
    assert (r.json()["score"]["points_earned"], r.json()["score"]["critical_missed"]) == ("2.00", 1)
    assert len(ScoreRepository(db, org_a.org.id).for_brief(brief.id)) == 1  # updated in place


def test_override_requires_comment_and_real_quote(client, db, org_a):
    _, items, brief, _ = scored_case(db, org_a)
    fac = login(client, org_a, org_a.faculty)
    assert override(client, fac, brief, items[3], matched=True, comment="").status_code == 422
    assert override(client, fac, brief, items[3], matched=True, comment="ok",
                    evidence_quote="not in the brief").status_code == 422


# --- timeline lock (API-enforced) ------------------------------------------------------


def test_resident_cannot_see_timeline_or_ocr_until_submitted(client, db, org_a, no_celery):
    case, doc, _ = make_case(db, org_a)
    add_answer_key(db, org_a, case)
    res = login(client, org_a, org_a.resident)
    timeline, page = f"/cases/{case.id}/timeline", f"/documents/{doc.id}/pages/1"

    assert client.get(timeline, headers=res).status_code == 403
    assert client.get(page, headers=res).status_code == 403
    assert client.get(f"{page}/image", headers=res).status_code != 403  # raw page image stays visible

    assert client.put(f"/cases/{case.id}/brief", headers=res, json=BRIEF).status_code == 200
    assert client.get(timeline, headers=res).status_code == 403  # a draft does not unlock

    # Another resident's submission does not unlock it for this resident.
    other = UserRepository(db, org_a.org.id).create("resident2@org-a.example.com", "Resident Two", PASSWORD, Role.RESIDENT)
    submitted_brief(db, org_a, case, resident=other)
    assert client.get(timeline, headers=res).status_code == 403

    r = client.post(f"/cases/{case.id}/brief/submit", headers=res)
    assert r.status_code == 200 and r.json()["status"] == "submitted"
    assert [str(x) for x in no_celery] == [r.json()["id"]]  # matching + scoring enqueued once
    assert client.get(timeline, headers=res).status_code == 200
    assert client.get(page, headers=res).status_code == 200

    assert client.get(timeline, headers=login(client, org_a, org_a.faculty)).status_code == 200


def test_brief_lifecycle_and_roles(client, db, org_a):
    case, _, _ = make_case(db, org_a)
    res, fac = login(client, org_a, org_a.resident), login(client, org_a, org_a.faculty)
    url = f"/cases/{case.id}/brief"
    assert client.get(url, headers=res).status_code == 404
    assert client.put(url, headers=res, json={"key_changes": "x", "bogus": "y"}).status_code == 422
    assert client.put(url, headers=res, json={"key_changes": ""}).status_code == 200
    assert client.post(f"{url}/submit", headers=res).status_code == 422  # empty brief
    assert client.put(url, headers=res, json=BRIEF).json()["sections"]["red_flags"] == "ER and PR positive."
    assert client.post(f"{url}/submit", headers=res).status_code == 200
    assert client.put(url, headers=res, json=BRIEF).status_code == 409
    assert client.post(f"{url}/submit", headers=res).status_code == 409

    assert client.put(url, headers=fac, json=BRIEF).status_code == 403
    for path in ("/faculty/briefs", "/faculty/residents", f"/faculty/residents/{org_a.resident.id}/trend"):
        assert client.get(path, headers=res).status_code == 403


def test_faculty_does_not_see_drafts(client, db, org_a):
    case, _, _ = make_case(db, org_a)
    draft = ReadinessBriefRepository(db, org_a.org.id).add(case_id=case.id, author_user_id=org_a.resident.id,
                                                          content=BRIEF)
    fac = login(client, org_a, org_a.faculty)
    assert client.get("/faculty/briefs", headers=fac).json() == []
    assert client.get(f"/faculty/briefs/{draft.id}", headers=fac).status_code == 404


# --- cross-org isolation on every new endpoint -----------------------------------------


def test_cross_org_isolation(client, db, org_a, org_b):
    case_a, items_a, brief_a, _ = scored_case(db, org_a)
    scored_case(db, org_b)
    res_b, fac_b = login(client, org_b, org_b.resident), login(client, org_b, org_b.faculty)

    url = f"/cases/{case_a.id}/brief"
    assert client.get(url, headers=res_b).status_code == 404
    assert client.put(url, headers=res_b, json=BRIEF).status_code == 404
    assert client.post(f"{url}/submit", headers=res_b).status_code == 404
    assert client.get(f"/cases/{case_a.id}/timeline", headers=res_b).status_code == 404

    listed = client.get("/faculty/briefs", headers=fac_b).json()
    assert brief_a.id not in {b["id"] for b in listed} and len(listed) == 1
    assert client.get("/faculty/briefs", headers=fac_b, params={"resident_id": str(org_a.resident.id)}).json() == []
    assert client.get(f"/faculty/briefs/{brief_a.id}", headers=fac_b).status_code == 404
    assert override(client, fac_b, brief_a, items_a[0], matched=False, comment="x").status_code == 404
    assert client.delete(f"/faculty/briefs/{brief_a.id}/items/{items_a[0].id}/override", headers=fac_b).status_code == 404
    assert client.get(f"/faculty/residents/{org_a.resident.id}/trend", headers=fac_b).status_code == 404
    assert {r["email"] for r in client.get("/faculty/residents", headers=fac_b).json()} == {org_b.resident.email}

    # An org_b rubric item id cannot be overridden on an org_a brief either.
    _, items_b2, _, _ = scored_case(db, org_b, code="SYN-B2")
    fac_a = login(client, org_a, org_a.faculty)
    assert override(client, fac_a, brief_a, items_b2[0], matched=True, comment="x").status_code == 404
    assert ReadinessBriefRepository(db, org_b.org.id).get(brief_a.id) is None


# --- trend -----------------------------------------------------------------------------


def test_trend_shows_repeatedly_missed_categories(client, db, org_a):
    scored_case(db, org_a, code="C-1")  # misses discrepancies
    scored_case(db, org_a, code="C-2", matches=GOOD_MATCHES[1:])  # misses discrepancies + critical pending
    trend = client.get(f"/faculty/residents/{org_a.resident.id}/trend", headers=login(client, org_a, org_a.faculty)).json()
    assert [c["score"]["percent"] for c in trend["cases"]] == ["87.50", "50.00"]
    cats = {c["category"]: c for c in trend["categories"]}
    assert cats["discrepancies"]["repeatedly_missed"] is True and cats["discrepancies"]["miss_rate"] == 1.0
    assert cats["pending_tests"]["cases_with_miss"] == 1 and cats["pending_tests"]["critical_missed"] == 1
    assert cats["pathology"]["missed"] == 0
    assert trend["categories"][0]["category"] == "discrepancies"
