"""Proves one org cannot read (or link to) another org's data."""

import pytest
from sqlalchemy.exc import IntegrityError

from app.repositories.cases import CaseRepository, DocumentPageRepository, SourceDocumentRepository
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
