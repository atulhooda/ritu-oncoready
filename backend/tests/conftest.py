import os
from dataclasses import dataclass
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from app.db import get_db
from app.main import app
from app.models import Org, Role, User
from app.repositories.orgs import OrgRepository
from app.repositories.users import UserRepository

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://postgres:postgres@localhost:5432/oncoready_test"
)
BACKEND_DIR = Path(__file__).resolve().parents[1]
PASSWORD = "synthetic-pass-123"


@pytest.fixture(scope="session")
def engine():
    eng = create_engine(TEST_DATABASE_URL)
    with eng.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    # Build the schema from the real migrations, not create_all().
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", TEST_DATABASE_URL)
    command.upgrade(cfg, "head")
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine):
    """Each test runs in a transaction that is rolled back afterwards."""
    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    yield session
    session.close()
    trans.rollback()
    conn.close()


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@dataclass
class Tenant:
    org: Org
    admin: User
    faculty: User
    resident: User


def make_tenant(db: Session, slug: str) -> Tenant:
    org = OrgRepository(db).create(name=f"Synthetic Hospital {slug}", slug=slug)
    users = UserRepository(db, org.id)
    return Tenant(
        org=org,
        admin=users.create(f"admin@{slug}.example.com", "Admin", PASSWORD, Role.ADMIN),
        faculty=users.create(f"faculty@{slug}.example.com", "Faculty", PASSWORD, Role.FACULTY),
        resident=users.create(f"resident@{slug}.example.com", "Resident", PASSWORD, Role.RESIDENT),
    )


@pytest.fixture
def org_a(db) -> Tenant:
    return make_tenant(db, "org-a")


@pytest.fixture
def org_b(db) -> Tenant:
    return make_tenant(db, "org-b")


def login(client: TestClient, tenant: Tenant, user: User) -> dict:
    r = client.post(
        "/auth/login", json={"org_slug": tenant.org.slug, "email": user.email, "password": PASSWORD}
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
