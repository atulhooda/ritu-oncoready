import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, Numeric, String, Text, UniqueConstraint, false, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk


class AnswerKey(TenantMixin, Base):
    """Faculty-authored expected findings for a case. Versioned; scores pin a version."""

    __tablename__ = "answer_keys"
    __table_args__ = tenant_args(
        UniqueConstraint("case_id", "version"),
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("authored_by_user_id", "users", ondelete=None),
        CheckConstraint("status IN ('draft', 'final')", name="status"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    version: Mapped[int] = mapped_column(Integer, server_default="1")
    status: Mapped[str] = mapped_column(String(16), server_default="draft")
    authored_by_user_id: Mapped[uuid.UUID]
    notes: Mapped[str | None] = mapped_column(Text)


class RubricItem(TenantMixin, Base):
    __tablename__ = "rubric_items"
    __table_args__ = tenant_args(
        tenant_fk("answer_key_id", "answer_keys"),
        CheckConstraint("weight > 0", name="weight_positive"),
    )

    answer_key_id: Mapped[uuid.UUID] = mapped_column(index=True)
    category: Mapped[str] = mapped_column(String(64))
    description: Mapped[str] = mapped_column(Text)
    # Inputs for the deterministic matcher (e.g. required terms). Never an LLM prompt.
    match_criteria: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    weight: Mapped[Decimal] = mapped_column(Numeric(8, 2))
    is_critical: Mapped[bool] = mapped_column(Boolean, server_default=false())
    position: Mapped[int] = mapped_column(Integer, server_default="0")


class ReadinessBrief(TenantMixin, Base):
    """A resident's write-up of a case, scored against an answer key."""

    __tablename__ = "readiness_briefs"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("author_user_id", "users", ondelete=None),
        CheckConstraint("status IN ('draft', 'submitted')", name="status"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    author_user_id: Mapped[uuid.UUID] = mapped_column(index=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    status: Mapped[str] = mapped_column(String(16), server_default="draft")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BriefItemMatch(TenantMixin, Base):
    __tablename__ = "brief_item_matches"
    __table_args__ = tenant_args(
        UniqueConstraint("brief_id", "rubric_item_id"),
        tenant_fk("brief_id", "readiness_briefs"),
        tenant_fk("rubric_item_id", "rubric_items"),
        CheckConstraint("method IN ('deterministic', 'faculty_override')", name="method"),
    )

    brief_id: Mapped[uuid.UUID] = mapped_column(index=True)
    rubric_item_id: Mapped[uuid.UUID]
    matched: Mapped[bool] = mapped_column(Boolean)
    matched_text: Mapped[str | None] = mapped_column(Text)
    method: Mapped[str] = mapped_column(String(32), server_default="deterministic")


class Score(TenantMixin, Base):
    """Output of the deterministic scorer. Same inputs + scoring_version => same row."""

    __tablename__ = "scores"
    __table_args__ = tenant_args(
        UniqueConstraint("brief_id", "answer_key_id", "scoring_version"),
        tenant_fk("brief_id", "readiness_briefs"),
        tenant_fk("answer_key_id", "answer_keys"),
        CheckConstraint("points_earned >= 0 AND points_earned <= points_possible", name="points_range"),
        CheckConstraint("critical_missed >= 0", name="critical_missed_nonnegative"),
    )

    brief_id: Mapped[uuid.UUID] = mapped_column(index=True)
    answer_key_id: Mapped[uuid.UUID]
    scoring_version: Mapped[str] = mapped_column(String(32))
    points_earned: Mapped[Decimal] = mapped_column(Numeric(8, 2))
    points_possible: Mapped[Decimal] = mapped_column(Numeric(8, 2))
    critical_missed: Mapped[int] = mapped_column(Integer, server_default="0")
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class FacultyReview(TenantMixin, Base):
    __tablename__ = "faculty_reviews"
    __table_args__ = tenant_args(
        tenant_fk("brief_id", "readiness_briefs"),
        tenant_fk("reviewer_user_id", "users", ondelete=None),
        tenant_fk("score_id", "scores", ondelete=None),
        CheckConstraint("status IN ('pending', 'approved', 'changes_requested')", name="status"),
    )

    brief_id: Mapped[uuid.UUID] = mapped_column(index=True)
    reviewer_user_id: Mapped[uuid.UUID]
    score_id: Mapped[uuid.UUID | None]
    status: Mapped[str] = mapped_column(String(32), server_default="pending")
    comments: Mapped[str | None] = mapped_column(Text)
