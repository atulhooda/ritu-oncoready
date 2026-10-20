import uuid
from collections.abc import Sequence
from typing import Any, ClassVar, Generic, TypeVar

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.models.base import TenantMixin

M = TypeVar("M", bound=TenantMixin)


class TenantRepository(Generic[M]):
    """The only sanctioned way to touch tenant data.

    Bound to one org at construction; every read is filtered by that org_id and every
    write is stamped with it. Callers can never pass org_id themselves.
    """

    model: ClassVar[type]

    def __init__(self, session: Session, org_id: uuid.UUID):
        if org_id is None:
            raise ValueError("org_id is required")
        self.session = session
        self.org_id = org_id

    def select(self) -> Select:
        return select(self.model).where(self.model.org_id == self.org_id)

    def get(self, id: uuid.UUID) -> M | None:
        return self.session.scalar(self.select().where(self.model.id == id))

    def list(self, *where: Any, limit: int = 100, offset: int = 0) -> Sequence[M]:
        stmt = self.select().where(*where).order_by(self.model.created_at).limit(limit).offset(offset)
        return self.session.scalars(stmt).all()

    def add(self, **fields: Any) -> M:
        if "org_id" in fields:
            raise ValueError("org_id is set by the repository, not the caller")
        obj = self.model(org_id=self.org_id, **fields)
        self.session.add(obj)
        self.session.flush()
        return obj
