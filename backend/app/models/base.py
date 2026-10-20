import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, MetaData, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class TenantMixin:
    """Every tenant-owned table: uuid id, org_id, created_at.

    Tables using this mixin must include `tenant_args()` in `__table_args__` so that
    `(org_id, id)` is unique and can be the target of composite foreign keys.
    """

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orgs.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


def tenant_args(*extra):
    return (UniqueConstraint("org_id", "id"), *extra)


def tenant_fk(column: str, target_table: str, ondelete: str | None = "CASCADE"):
    """Composite FK (org_id, column) -> target(org_id, id): the DB rejects cross-org links."""
    return ForeignKeyConstraint(
        ["org_id", column],
        [f"{target_table}.org_id", f"{target_table}.id"],
        ondelete=ondelete,
    )
