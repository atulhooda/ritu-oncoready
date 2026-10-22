import uuid
from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

SEXES = ("female", "male", "intersex", "other", "prefer_not_to_say")
# Ritu's spoken languages (ritu voice/spokenLanguages.js), same codes.
LANGUAGES = ("en-IN", "hi-IN", "mr-IN", "kn-IN", "pa-IN", "ta-IN", "te-IN", "bn-IN", "gu-IN", "ml-IN", "od-IN")
TREATMENT_STATUSES = ("not_started", "on_treatment", "completed", "follow_up", "not_sure")
# How an ABHA link was checked: the ABDM sandbox OTP flow, or demo mode (no ABDM credentials).
ABHA_VERIFIED_VIA = ("abdm_sandbox", "demo")


class PatientProfile(TenantMixin, Base):
    """Details a (demo) patient enters about themselves. Patient-reported, not verified."""

    __tablename__ = "patient_profiles"
    __table_args__ = tenant_args(
        UniqueConstraint("patient_user_id"),
        tenant_fk("patient_user_id", "users"),
        CheckConstraint(f"sex IS NULL OR sex IN {SEXES}", name="sex"),
        CheckConstraint(f"preferred_language IN {LANGUAGES}", name="preferred_language"),
        CheckConstraint(f"treatment_status IS NULL OR treatment_status IN {TREATMENT_STATUSES}", name="treatment_status"),
        CheckConstraint("date_of_birth IS NULL OR date_of_birth > '1900-01-01'", name="date_of_birth_plausible"),
        CheckConstraint(f"abha_verified_via IS NULL OR abha_verified_via IN {ABHA_VERIFIED_VIA}", name="abha_verified_via"),
        # an ABHA is only ever stored as a completed OTP link
        CheckConstraint(
            "(abha_number_masked IS NULL) = (abha_verified_at IS NULL) AND (abha_verified_at IS NULL) = (abha_verified_via IS NULL)",
            name="abha_link_complete",
        ),
    )

    patient_user_id: Mapped[uuid.UUID]
    date_of_birth: Mapped[date | None] = mapped_column(Date)
    sex: Mapped[str | None] = mapped_column(String(24))
    phone: Mapped[str | None] = mapped_column(String(32))
    preferred_language: Mapped[str] = mapped_column(String(8), server_default="en-IN")
    cancer_type: Mapped[str | None] = mapped_column(String(120))
    diagnosed_on: Mapped[date | None] = mapped_column(Date)  # month precision: first day of the month
    stage_reported: Mapped[str | None] = mapped_column(String(60))
    treatment_status: Mapped[str | None] = mapped_column(String(24))
    current_treatment: Mapped[str | None] = mapped_column(Text)
    treating_hospital: Mapped[str | None] = mapped_column(String(200))
    treating_doctor: Mapped[str | None] = mapped_column(String(200))
    other_conditions: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())
    # Linked ABHA (Ayushman Bharat Health Account). Only the last four digits of the number are kept.
    abha_number_masked: Mapped[str | None] = mapped_column(String(20))
    abha_address: Mapped[str | None] = mapped_column(String(100))
    abha_name: Mapped[str | None] = mapped_column(String(200))  # name on the ABHA, as ABDM returned it
    abha_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    abha_verified_via: Mapped[str | None] = mapped_column(String(16))
