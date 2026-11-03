import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

# unassigned (sent by the patient) -> with_junior (hospital assigned it) -> with_senior (junior sent it)
REVIEW_STATUSES = ("unassigned", "with_junior", "with_senior")


class CaseReview(TenantMixin, Base):
    """A sent patient's path through the hospital: assigned to a junior doctor, who writes a summary
    and sends it to a senior doctor. One per patient case."""

    __tablename__ = "case_reviews"
    __table_args__ = tenant_args(
        UniqueConstraint("case_id"),
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("junior_user_id", "users", ondelete=None),
        tenant_fk("senior_user_id", "users", ondelete=None),
        tenant_fk("summary_updated_by", "users", ondelete=None),
        CheckConstraint(f"status IN {REVIEW_STATUSES}", name="status"),
        CheckConstraint("status = 'unassigned' OR junior_user_id IS NOT NULL", name="assigned_has_junior"),
        CheckConstraint("(status = 'with_senior') = (senior_user_id IS NOT NULL)", name="senior_when_sent"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    status: Mapped[str] = mapped_column(String(16), server_default="unassigned")
    junior_user_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    senior_user_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    assigned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The junior's summary for the senior: which reported points to show ("facts": intake fact ids)
    # and their notes ("findings", "concerns", "questions"). Null until first saved (a draft is shown).
    content: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # The same summary as plain text, built in code from `content` (for reading outside the app).
    summary: Mapped[str | None] = mapped_column(Text)
    summary_updated_by: Mapped[uuid.UUID | None]
    summary_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
