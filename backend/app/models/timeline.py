import uuid
from datetime import date
from typing import Any

from sqlalchemy import CheckConstraint, Date, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

EVENT_CATEGORIES = ("presentation", "imaging", "pathology", "lab", "procedure", "treatment", "consult", "other")


class ProvenanceMixin:
    """Every extracted fact points at the page it came from and the verbatim text on it."""

    source_page_id: Mapped[uuid.UUID] = mapped_column(index=True)
    source_text_span: Mapped[str] = mapped_column(Text)
    extracted_by: Mapped[str | None] = mapped_column(String(64))  # model id, or "manual"


def provenance_args():
    return (
        tenant_fk("source_page_id", "document_pages"),
        CheckConstraint("length(btrim(source_text_span)) > 0", name="source_text_span_not_blank"),
    )


class TimelineEvent(ProvenanceMixin, TenantMixin, Base):
    __tablename__ = "timeline_events"
    __table_args__ = tenant_args(
        *provenance_args(),
        tenant_fk("case_id", "patient_cases"),
        CheckConstraint(f"category IN {EVENT_CATEGORIES}", name="category"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    event_date: Mapped[date] = mapped_column(Date)
    category: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class PendingTest(ProvenanceMixin, TenantMixin, Base):
    __tablename__ = "pending_tests"
    __table_args__ = tenant_args(
        *provenance_args(),
        tenant_fk("case_id", "patient_cases"),
        CheckConstraint("status IN ('ordered', 'pending', 'resulted', 'cancelled')", name="status"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    test_name: Mapped[str] = mapped_column(String(200))
    ordered_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))


class Discrepancy(TenantMixin, Base):
    """Derived, not extracted: a conflict between two timeline events (which carry provenance)."""

    __tablename__ = "discrepancies"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("event_a_id", "timeline_events"),
        tenant_fk("event_b_id", "timeline_events"),
        CheckConstraint("event_a_id <> event_b_id", name="distinct_events"),
        CheckConstraint("status IN ('open', 'resolved', 'dismissed')", name="status"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    event_a_id: Mapped[uuid.UUID]
    event_b_id: Mapped[uuid.UUID]
    field: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default="open")
