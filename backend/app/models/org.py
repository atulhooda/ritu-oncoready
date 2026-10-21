import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, String, UniqueConstraint, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args


class Org(Base):
    """The tenant. Its `id` is the `org_id` carried by every other table."""

    __tablename__ = "orgs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Role(enum.StrEnum):
    RESIDENT = "resident"
    FACULTY = "faculty"
    ADMIN = "admin"
    PATIENT = "patient"  # demo persona who talks to Ritu and uploads their records
    DOCTOR = "doctor"  # receives published intake summaries and records


class User(TenantMixin, Base):
    __tablename__ = "users"
    __table_args__ = tenant_args(
        UniqueConstraint("org_id", "email"),
        CheckConstraint("role IN ('resident', 'faculty', 'admin', 'patient', 'doctor')", name="role"),
    )

    email: Mapped[str] = mapped_column(String(320))
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=true())
