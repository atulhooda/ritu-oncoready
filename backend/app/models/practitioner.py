import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk


class PractitionerProfile(TenantMixin, Base):
    """A doctor's professional identity, shown on the reports they read. Self-declared: the HPR ID
    (Healthcare Professionals Registry, ABDM) and council registration are not verified yet."""

    __tablename__ = "practitioner_profiles"
    __table_args__ = tenant_args(
        UniqueConstraint("user_id"),
        tenant_fk("user_id", "users"),
        CheckConstraint("hpr_id IS NULL OR hpr_id ~ '^[0-9]{14}$'", name="hpr_id_14_digits"),
    )

    user_id: Mapped[uuid.UUID]
    hpr_id: Mapped[str | None] = mapped_column(String(14))  # digits only
    registration_number: Mapped[str | None] = mapped_column(String(40))
    medical_council: Mapped[str | None] = mapped_column(String(120))
    qualification: Mapped[str | None] = mapped_column(String(200))  # e.g. "MBBS, MD, DM (Medical Oncology)"
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())
