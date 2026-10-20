import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, Integer, Numeric, String, Text, UniqueConstraint, false, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk


# draft -> submitted -> scored (or scoring_failed; see scoring_error)
BRIEF_STATUSES = ("draft", "submitted", "scored", "scoring_failed")


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
        UniqueConstraint("case_id", "author_user_id"),  # one brief per resident per case
        CheckConstraint(f"status IN {BRIEF_STATUSES}", name="status"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    author_user_id: Mapped[uuid.UUID] = mapped_column(index=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    status: Mapped[str] = mapped_column(String(16), server_default="draft")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scoring_error: Mapped[str | None] = mapped_column(Text)


class BriefItemMatch(TenantMixin, Base):
    __tablename__ = "brief_item_matches"
    __table_args__ = tenant_args(
        UniqueConstraint("brief_id", "rubric_item_id"),
        tenant_fk("brief_id", "readiness_briefs"),
        tenant_fk("rubric_item_id", "rubric_items"),
        tenant_fk("overridden_by_user_id", "users", ondelete=None),
        CheckConstraint("method IN ('deterministic', 'llm', 'faculty_override')", name="method"),
        CheckConstraint(
            "override_matched IS NULL OR length(btrim(coalesce(override_comment, ''))) > 0",
            name="override_needs_comment",
        ),
    )

    brief_id: Mapped[uuid.UUID] = mapped_column(index=True)
    rubric_item_id: Mapped[uuid.UUID]
    # Matcher's verdict. `matched_text` is the resident's verbatim quote (verified in code).
    matched: Mapped[bool] = mapped_column(Boolean)
    matched_text: Mapped[str | None] = mapped_column(Text)
    evidence_section: Mapped[str | None] = mapped_column(String(40))
    method: Mapped[str] = mapped_column(String(32), server_default="llm")
    # Matcher proposals for this item whose quote was not in the brief: [{section, quote, reason}]
    rejected_evidence: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    # Faculty override; when set it wins over `matched`. A comment is required.
    override_matched: Mapped[bool | None] = mapped_column(Boolean)
    override_comment: Mapped[str | None] = mapped_column(Text)
    overridden_by_user_id: Mapped[uuid.UUID | None]
    overridden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def effective_matched(self) -> bool:
        return self.matched if self.override_matched is None else self.override_matched


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
