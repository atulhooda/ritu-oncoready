import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Identity, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantMixin, tenant_args, tenant_fk

REQUEST_KINDS = ("record", "question")  # upload a record they have; answer a question in words
REQUEST_STATUSES = ("open", "answered")


class PatientRequest(TenantMixin, Base):
    """A doctor asking the patient for more before the consultation: a record they mentioned but
    did not upload, or a question. The patient answers from their own page."""

    __tablename__ = "patient_requests"
    __table_args__ = tenant_args(
        tenant_fk("case_id", "patient_cases"),
        tenant_fk("requested_by", "users", ondelete=None),
        # the record the patient sent; unlinked (not the request deleted) if they remove that record
        tenant_fk("answer_document_id", "source_documents", ondelete=None),
        CheckConstraint(f"kind IN {REQUEST_KINDS}", name="kind"),
        CheckConstraint(f"status IN {REQUEST_STATUSES}", name="status"),
        CheckConstraint("length(btrim(text)) > 0", name="text_not_blank"),
        CheckConstraint("(status = 'answered') = (answered_at IS NOT NULL)", name="answered_when_answered"),
        CheckConstraint("kind = 'record' OR status = 'open' OR length(btrim(answer)) > 0", name="question_answer"),
    )

    seq: Mapped[int] = mapped_column(BigInteger, Identity())  # order asked (created_at ties within a transaction)
    case_id: Mapped[uuid.UUID] = mapped_column(index=True)
    requested_by: Mapped[uuid.UUID]
    kind: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default="open")
    answer: Mapped[str | None] = mapped_column(Text)
    answer_document_id: Mapped[uuid.UUID | None]
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
