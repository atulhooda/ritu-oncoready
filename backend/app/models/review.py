import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Identity, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

# unassigned (sent by the patient) -> with_junior (hospital assigned it) -> with_senior (junior sent it)
REVIEW_STATUSES = ("unassigned", "with_junior", "with_senior")
# Every change to a review, oldest first; never edited or deleted (the audit trail).
REVIEW_ACTIONS = ("assigned", "saved", "sent", "reviewed", "returned")


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
        tenant_fk("reviewed_by", "users", ondelete=None),
        # The senior's sign-off: only on a summary that is with them, and both fields together.
        CheckConstraint("(reviewed_at IS NULL) = (reviewed_by IS NULL)", name="reviewed_together"),
        CheckConstraint("reviewed_at IS NULL OR status = 'with_senior'", name="reviewed_when_sent"),
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
    reviewed_by: Mapped[uuid.UUID | None]
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ReviewEvent(TenantMixin, Base):
    """One change to a patient's review: who did what, when, with the summary as it stood then and
    the senior's reason when they return it. Append-only; created_at is the time."""

    __tablename__ = "review_events"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("actor_user_id", "users", ondelete=None),
        CheckConstraint(f"action IN {REVIEW_ACTIONS}", name="action"),
        CheckConstraint("action <> 'returned' OR length(btrim(note)) > 0", name="returned_has_reason"),
    )

    # the order of events (created_at is the same for everything in one transaction)
    seq: Mapped[int] = mapped_column(BigInteger, Identity())
    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    actor_user_id: Mapped[uuid.UUID | None]  # None: assigned automatically
    action: Mapped[str] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
