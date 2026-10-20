"""Proves one org cannot read (or link to) another org's data."""

import pytest

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
