"""Proves one org cannot read (or link to) another org's data."""

from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import Base
from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository
from app.repositories.scoring import (
    AnswerKeyRepository,
    BriefItemMatchRepository,
    FacultyReviewRepository,
    ReadinessBriefRepository,
    RubricItemRepository,
    ScoreRepository,
)
from app.repositories.timeline import (
    DiscrepancyRepository,
    PendingTestRepository,
    ProvenanceError,
    RejectedExtractionRepository,
    TimelineEventRepository,
)
from app.repositories.users import UserRepository
from tests.conftest import PASSWORD, login


def test_user_repository_is_scoped(db, org_a, org_b):
    repo_a = UserRepository(db, org_a.org.id)
    assert repo_a.get(org_b.admin.id) is None
    assert repo_a.get_by_email(org_b.admin.email) is None
    assert {u.org_id for u in repo_a.list()} == {org_a.org.id}


def test_repository_refuses_caller_supplied_org_id(db, org_a, org_b):
    with pytest.raises(ValueError):
        UserRepository(db, org_a.org.id).add(org_id=org_b.org.id, email="x@example.com")


def test_cannot_log_in_to_another_org(client, org_a, org_b):
    r = client.post(
        "/auth/login",
        json={"org_slug": org_b.org.slug, "email": org_a.admin.email, "password": PASSWORD},
    )
    assert r.status_code == 401


def test_me_returns_own_org(client, org_a, org_b):
    r = client.get("/auth/me", headers=login(client, org_a, org_a.resident))
    assert r.status_code == 200
    assert r.json()["org_id"] == str(org_a.org.id)
    assert r.json()["org_name"] == org_a.org.name


# --- cases, documents, pages ------------------------------------------------------------


def make_case(db, tenant, code="SYN-001"):
    case = CaseRepository(db, tenant.org.id).add(
        case_code=code, title=f"Synthetic case {code}", created_by_user_id=tenant.faculty.id
    )
    doc = SourceDocumentRepository(db, tenant.org.id).add(
        case_id=case.id,
        filename="synthetic_path_report.pdf",
        mime_type="application/pdf",
        storage_key=f"{tenant.org.slug}/{code}/report.pdf",
        page_count=1,
        uploaded_by_user_id=tenant.faculty.id,
    )
    page = DocumentPageRepository(db, tenant.org.id).add(
        document_id=doc.id, page_number=1, ocr_text="Synthetic biopsy dated 2026-01-05.", confidence=0.97
    )
    return case, doc, page


def test_case_repositories_are_scoped(db, org_a, org_b):
    case_a, doc_a, page_a = make_case(db, org_a)
    make_case(db, org_b)
    assert CaseRepository(db, org_b.org.id).get(case_a.id) is None
    assert SourceDocumentRepository(db, org_b.org.id).get(doc_a.id) is None
    assert SourceDocumentRepository(db, org_b.org.id).for_case(case_a.id) == []
    assert DocumentPageRepository(db, org_b.org.id).get(page_a.id) is None
    assert DocumentPageRepository(db, org_b.org.id).for_document(doc_a.id) == []
    assert [c.id for c in CaseRepository(db, org_a.org.id).list()] == [case_a.id]


def test_case_api_hides_other_org(client, db, org_a, org_b):
    case_a, _, _ = make_case(db, org_a)
    case_b, _, _ = make_case(db, org_b)
    headers_b = login(client, org_b, org_b.resident)

    listed = client.get("/cases", headers=headers_b).json()
    assert [c["id"] for c in listed] == [str(case_b.id)]
    assert client.get(f"/cases/{case_a.id}", headers=headers_b).status_code == 404
    assert client.get(f"/cases/{case_a.id}/documents", headers=headers_b).status_code == 404
    # sanity: the owner can see it
    assert client.get(f"/cases/{case_a.id}", headers=login(client, org_a, org_a.resident)).status_code == 200


def test_created_case_belongs_to_token_org(client, db, org_a, org_b):
    r = client.post("/cases", headers=login(client, org_a, org_a.faculty), json={"case_code": "NEW-1", "title": "T"})
    assert r.status_code == 201
    assert CaseRepository(db, org_b.org.id).get(r.json()["id"]) is None
    assert CaseRepository(db, org_a.org.id).get(r.json()["id"]) is not None


def test_db_rejects_cross_org_document_link(db, org_a, org_b):
    case_a, _, _ = make_case(db, org_a)
    with pytest.raises(IntegrityError):
        SourceDocumentRepository(db, org_b.org.id).add(
            case_id=case_a.id,
            filename="x.pdf",
            mime_type="application/pdf",
            storage_key="x",
            uploaded_by_user_id=org_b.faculty.id,
        )


# --- timeline, pending tests, discrepancies ---------------------------------------------


def make_events(db, tenant, case, page):
    events = TimelineEventRepository(db, tenant.org.id)
    e1 = events.add(
        case_id=case.id, event_date=date(2026, 1, 5), category="pathology",
        source_page_id=page.id, source_text_span="Synthetic biopsy",
    )
    e2 = events.add(
        case_id=case.id, event_date=date(2026, 1, 6), category="pathology",
        source_page_id=page.id, source_text_span="dated 2026-01-05",
    )
    test = PendingTestRepository(db, tenant.org.id).add(
        case_id=case.id, test_name="Synthetic marker panel", source_page_id=page.id,
        source_text_span="Synthetic biopsy",
    )
    disc = DiscrepancyRepository(db, tenant.org.id).add(
        case_id=case.id, event_a_id=e1.id, event_b_id=e2.id, field="event_date", description="Dates differ",
    )
    return e1, test, disc


def test_timeline_repositories_are_scoped(db, org_a, org_b):
    case_a, _, page_a = make_case(db, org_a)
    event_a, test_a, disc_a = make_events(db, org_a, case_a, page_a)

    assert TimelineEventRepository(db, org_b.org.id).get(event_a.id) is None
    assert TimelineEventRepository(db, org_b.org.id).for_case(case_a.id) == []
    assert PendingTestRepository(db, org_b.org.id).get(test_a.id) is None
    assert DiscrepancyRepository(db, org_b.org.id).get(disc_a.id) is None
    assert len(TimelineEventRepository(db, org_a.org.id).for_case(case_a.id)) == 2


def test_cannot_cite_another_orgs_page(db, org_a, org_b):
    _, _, page_a = make_case(db, org_a)
    case_b, _, _ = make_case(db, org_b)
    with pytest.raises(ProvenanceError):
        TimelineEventRepository(db, org_b.org.id).add(
            case_id=case_b.id, event_date=date(2026, 1, 5), category="lab",
            source_page_id=page_a.id, source_text_span="Synthetic biopsy",
        )


def test_span_must_be_verbatim(db, org_a):
    case_a, _, page_a = make_case(db, org_a)
    with pytest.raises(ProvenanceError):
        TimelineEventRepository(db, org_a.org.id).add(
            case_id=case_a.id, event_date=date(2026, 1, 5), category="lab",
            source_page_id=page_a.id, source_text_span="text that is not on the page",
        )


def test_rejected_extractions_are_scoped(db, org_a, org_b):
    case_a, doc_a, _ = make_case(db, org_a)
    rej = RejectedExtractionRepository(db, org_a.org.id).add(
        case_id=case_a.id, document_id=doc_a.id, page_number=1, reason="span_not_found",
        candidate={"source_text_span": "not on page"},
    )
    assert RejectedExtractionRepository(db, org_b.org.id).get(rej.id) is None
    assert RejectedExtractionRepository(db, org_b.org.id).for_case(case_a.id) == []
    assert RejectedExtractionRepository(db, org_a.org.id).get(rej.id) is not None


# --- answer keys, rubric, briefs, matches, scores, reviews ------------------------------


def make_scoring(db, tenant, case):
    org_id = tenant.org.id
    key = AnswerKeyRepository(db, org_id).add(case_id=case.id, authored_by_user_id=tenant.faculty.id)
    item = RubricItemRepository(db, org_id).add(
        answer_key_id=key.id, category="pending_tests", description="Notes the outstanding marker panel",
        weight=2, is_critical=True,
    )
    brief = ReadinessBriefRepository(db, org_id).add(
        case_id=case.id, author_user_id=tenant.resident.id, content={"text": "Marker panel pending."}
    )
    match = BriefItemMatchRepository(db, org_id).add(
        brief_id=brief.id, rubric_item_id=item.id, matched=True, matched_text="Marker panel pending."
    )
    score = ScoreRepository(db, org_id).add(
        brief_id=brief.id, answer_key_id=key.id, scoring_version="v1", points_earned=2, points_possible=2
    )
    review = FacultyReviewRepository(db, org_id).add(
        brief_id=brief.id, reviewer_user_id=tenant.faculty.id, score_id=score.id, status="approved"
    )
    return {
        AnswerKeyRepository: key,
        RubricItemRepository: item,
        ReadinessBriefRepository: brief,
        BriefItemMatchRepository: match,
        ScoreRepository: score,
        FacultyReviewRepository: review,
    }


def test_scoring_repositories_are_scoped(db, org_a, org_b):
    case_a, _, _ = make_case(db, org_a)
    rows_a = make_scoring(db, org_a, case_a)
    case_b, _, _ = make_case(db, org_b)
    make_scoring(db, org_b, case_b)

    for repo_cls, row_a in rows_a.items():
        assert repo_cls(db, org_b.org.id).get(row_a.id) is None, repo_cls.__name__
        assert row_a.id not in {r.id for r in repo_cls(db, org_b.org.id).list()}, repo_cls.__name__
        assert repo_cls(db, org_a.org.id).get(row_a.id) is not None, repo_cls.__name__

    brief_a = rows_a[ReadinessBriefRepository]
    assert BriefItemMatchRepository(db, org_b.org.id).for_brief(brief_a.id) == []
    assert ScoreRepository(db, org_b.org.id).for_brief(brief_a.id) == []
    assert RubricItemRepository(db, org_b.org.id).for_answer_key(rows_a[AnswerKeyRepository].id) == []


def test_db_rejects_cross_org_score_link(db, org_a, org_b):
    case_a, _, _ = make_case(db, org_a)
    rows_a = make_scoring(db, org_a, case_a)
    case_b, _, _ = make_case(db, org_b)
    brief_b = ReadinessBriefRepository(db, org_b.org.id).add(case_id=case_b.id, author_user_id=org_b.resident.id)
    with pytest.raises(IntegrityError):
        ScoreRepository(db, org_b.org.id).add(
            brief_id=brief_b.id, answer_key_id=rows_a[AnswerKeyRepository].id,
            scoring_version="v1", points_earned=0, points_possible=1,
        )


# --- schema-wide guard ------------------------------------------------------------------


def test_every_table_is_tenant_scoped(db):
    tables = db.scalars(text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name NOT IN ('orgs', 'alembic_version')"
    )).all()
    assert set(tables) == set(Base.metadata.tables) - {"orgs"}
    for table in tables:
        nullable = db.scalar(text(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = :t AND column_name = 'org_id'"
        ), {"t": table})
        assert nullable == "NO", f"{table} is missing a NOT NULL org_id"
