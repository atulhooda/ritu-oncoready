import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

# created -> in_progress -> completed (transcript received) -> summarized | failed; or expired
SESSION_STATUSES = ("created", "in_progress", "completed", "summarized", "failed", "expired")
SESSION_MODES = ("ritu", "simulator")  # simulator: typed stand-in until Ritu browser sessions exist
TURN_ROLES = ("patient", "ritu", "system")
FACT_SECTIONS = ("current_symptom", "medication", "allergy", "past_history", "previous_record")


class IntakeSession(TenantMixin, Base):
    """One pre-visit conversation between Ritu and a patient."""

    __tablename__ = "intake_sessions"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("patient_user_id", "users", ondelete=None),
        CheckConstraint(f"status IN {SESSION_STATUSES}", name="status"),
        CheckConstraint(f"mode IN {SESSION_MODES}", name="mode"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    patient_user_id: Mapped[uuid.UUID] = mapped_column(index=True)
    status: Mapped[str] = mapped_column(String(16), server_default="created")
    mode: Mapped[str] = mapped_column(String(16))
    language: Mapped[str] = mapped_column(String(8), server_default="en")
    ritu_session_id: Mapped[str | None] = mapped_column(String(100))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    extracted_by: Mapped[str | None] = mapped_column(String(64))
    # Extraction candidates that failed validation: [{candidate, reason, detail}] (audit only)
    rejected_facts: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))


class SessionTurn(TenantMixin, Base):
    __tablename__ = "session_turns"
    __table_args__ = tenant_args(
        UniqueConstraint("session_id", "turn_index"),
        tenant_fk("session_id", "intake_sessions"),
        CheckConstraint(f"role IN {TURN_ROLES}", name="role"),
        CheckConstraint("turn_index >= 0", name="turn_index_nonnegative"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    turn_index: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    spoken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IntakeFact(TenantMixin, Base):
    """A fact from the patient's own words. Provenance: the patient turn + verbatim span."""

    __tablename__ = "intake_facts"
    __table_args__ = tenant_args(
        tenant_fk("session_id", "intake_sessions"),
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("source_turn_id", "session_turns"),
        CheckConstraint(f"section IN {FACT_SECTIONS}", name="section"),
        CheckConstraint("length(btrim(source_text_span)) > 0", name="source_text_span_not_blank"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    section: Mapped[str] = mapped_column(String(32))
    label: Mapped[str] = mapped_column(String(300))  # short neutral restatement
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    source_turn_id: Mapped[uuid.UUID] = mapped_column(index=True)
    source_text_span: Mapped[str] = mapped_column(Text)
    extracted_by: Mapped[str | None] = mapped_column(String(64))
