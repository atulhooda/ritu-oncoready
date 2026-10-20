import uuid

from sqlalchemy import Boolean, CheckConstraint, Float, Integer, String, Text, UniqueConstraint, true
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk


# Pipeline: uploaded -> ocr_done -> extracted (or failed at any step, see `error`)
DOCUMENT_STATUSES = ("uploaded", "ocr_done", "extracted", "failed")


class PatientCase(TenantMixin, Base):
    """A synthetic teaching case. Real patient data is not allowed (CHECK is_synthetic)."""

    __tablename__ = "patient_cases"
    __table_args__ = tenant_args(
        UniqueConstraint("org_id", "case_code"),
        CheckConstraint("is_synthetic", name="synthetic_only"),
        CheckConstraint("status IN ('draft', 'published', 'archived')", name="status"),
        tenant_fk("created_by_user_id", "users", ondelete=None),
    )

    case_code: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(300))
    summary: Mapped[str | None] = mapped_column(Text)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, server_default=true())
    status: Mapped[str] = mapped_column(String(16), server_default="draft")
    created_by_user_id: Mapped[uuid.UUID]


class SourceDocument(TenantMixin, Base):
    __tablename__ = "source_documents"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("uploaded_by_user_id", "users", ondelete=None),
        CheckConstraint(f"status IN {DOCUMENT_STATUSES}", name="status"),
    )

    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    filename: Mapped[str] = mapped_column(String(300))
    mime_type: Mapped[str] = mapped_column(String(100))
    storage_key: Mapped[str] = mapped_column(String(500))
    page_count: Mapped[int | None] = mapped_column(Integer)
    uploaded_by_user_id: Mapped[uuid.UUID]
    status: Mapped[str] = mapped_column(String(16), server_default="uploaded")
    error: Mapped[str | None] = mapped_column(Text)


class DocumentPage(TenantMixin, Base):
    __tablename__ = "document_pages"
    __table_args__ = tenant_args(
        UniqueConstraint("document_id", "page_number"),
        CheckConstraint("page_number >= 1", name="page_number_positive"),
        CheckConstraint("confidence IS NULL OR (confidence >= 0 AND confidence <= 1)", name="confidence_range"),
        tenant_fk("document_id", "source_documents"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(index=True)
    page_number: Mapped[int] = mapped_column(Integer)
    ocr_text: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float)
    ocr_engine: Mapped[str | None] = mapped_column(String(32))  # "paddleocr" | "tesseract" | "seed"
