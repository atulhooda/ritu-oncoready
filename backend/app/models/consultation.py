import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

# processing: transcribing + drafting; draft: the doctor is editing; approved: final, the patient sees it
CONSULTATION_STATUSES = ("processing", "draft", "approved", "failed")
CONSULTATION_SOURCES = ("recording", "typed")


class Consultation(TenantMixin, Base):
    """A doctor-patient consultation the senior doctor recorded (the scribe). Sarvam transcribes it;
    the LLM extracts the prescription items the doctor said, each with a quote verified against the
    transcript; the doctor edits the report and approves it. Then the patient sees it too."""

    __tablename__ = "consultations"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("doctor_user_id", "users", ondelete=None),
        tenant_fk("approved_by", "users", ondelete=None),
        CheckConstraint(f"status IN {CONSULTATION_STATUSES}", name="status"),
        CheckConstraint(f"source IN {CONSULTATION_SOURCES}", name="source"),
        CheckConstraint("recording_consent", name="recording_consent"),  # never recorded without it
        CheckConstraint("(status = 'approved') = (approved_at IS NOT NULL)", name="approved_when_approved"),
        CheckConstraint("source = 'typed' OR recording_key IS NOT NULL", name="recording_has_audio"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    doctor_user_id: Mapped[uuid.UUID] = mapped_column(index=True)
    status: Mapped[str] = mapped_column(String(16), server_default="processing")
    source: Mapped[str] = mapped_column(String(16))
    recording_consent: Mapped[bool] = mapped_column(Boolean)
    recording_key: Mapped[str | None] = mapped_column(String(500))
    recording_mime: Mapped[str | None] = mapped_column(String(60))
    # [{turn_index, speaker (Sarvam's 0, 1 ... or None), text}], as transcribed; never rewritten
    transcript: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    doctor_speaker: Mapped[int | None] = mapped_column(Integer)  # which speaker is the doctor (LLM selection)
    # The extracted prescription, every item with {turn_index, quote}; kept as the audit copy.
    draft: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    rejected: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    # The report the doctor edits and approves (same shape as `draft`, quotes optional).
    report: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    extracted_by: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_by: Mapped[uuid.UUID | None]
