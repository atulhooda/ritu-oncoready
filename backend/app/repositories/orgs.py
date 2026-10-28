from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Org


class OrgRepository:
    """Orgs are the tenant root, so this is the one repository not bound to an org_id.
    Only used for bootstrap (creating an org) and resolving a slug at login."""

    def __init__(self, session: Session):
        self.session = session

    def get(self, org_id) -> Org | None:
        return self.session.get(Org, org_id)

    def get_by_slug(self, slug: str) -> Org | None:
        return self.session.scalar(select(Org).where(Org.slug == slug))

    def get_by_join_code(self, code: str) -> Org | None:
        return self.session.scalar(select(Org).where(Org.join_code == code.strip().upper()))

    def create(self, name: str, slug: str) -> Org:
        org = Org(name=name, slug=slug)
        self.session.add(org)
        self.session.flush()
        return org
