import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, String, UniqueConstraint, false, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args


class Org(Base):
    """The tenant. Its `id` is the `org_id` carried by every other table."""

    __tablename__ = "orgs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(64), unique=True)
    # Patients join a clinic through its code (/join/<code>). Sign-up is off until the clinic opens it.
    join_code: Mapped[str | None] = mapped_column(String(16), unique=True)
    patient_signup_open: Mapped[bool] = mapped_column(Boolean, server_default=false())
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
        UniqueConstraint("org_id", "phone"),
        UniqueConstraint("patient_number"),
        CheckConstraint("role IN ('resident', 'faculty', 'admin', 'patient', 'doctor')", name="role"),
        # staff sign in with email + password; patients who signed up sign in with phone + OTP
        CheckConstraint("email IS NOT NULL OR phone IS NOT NULL", name="has_login"),
        CheckConstraint("phone IS NULL OR phone ~ '^\\+[1-9][0-9]{7,14}$'", name="phone_e164"),
        CheckConstraint("patient_number IS NULL OR role = 'patient'", name="patient_number_for_patients"),
    )

    email: Mapped[str | None] = mapped_column(String(320))
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(16))  # E.164, e.g. +919812345678
    # The patient's OncoReady ID, unique across all clinics, e.g. OR-7K3F-9Q2D
    patient_number: Mapped[str | None] = mapped_column(String(16))
    role: Mapped[str] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=true())
