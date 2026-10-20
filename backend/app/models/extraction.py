import uuid
from typing import Any

from sqlalchemy import CheckConstraint, Float, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

REJECTION_REASONS = (
    "invalid_candidate",  # failed schema / field validation
    "page_out_of_range",  # cited page does not exist in the document
    "span_not_found",  # span did not fuzzy-match the page OCR text (< threshold)
    "value_not_in_span",  # numeric value not present in the verified span
)


class RejectedExtraction(TenantMixin, Base):
    """LLM candidates that failed validation. Never shown on the timeline; kept for audit."""

    __tablename__ = "rejected_extractions"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("document_id", "source_documents"),
        CheckConstraint(f"reason IN {REJECTION_REASONS}", name="reason"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(index=True)
    page_number: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(32))
    detail: Mapped[str | None] = mapped_column(Text)
    match_score: Mapped[float | None] = mapped_column(Float)  # rapidfuzz score 0..1, when computed
    candidate: Mapped[dict[str, Any]] = mapped_column(JSONB)  # raw LLM output for this item
    extracted_by: Mapped[str | None] = mapped_column(String(64))
