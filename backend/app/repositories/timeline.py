import uuid
from collections.abc import Sequence
from typing import Any

from app.models import Discrepancy, PendingTest, TimelineEvent
from app.repositories.base import M, TenantRepository
from app.repositories.cases import DocumentPageRepository, SourceDocumentRepository


class ProvenanceError(ValueError):
    pass


class ExtractedFactRepository(TenantRepository[M]):
    """Writes are rejected unless the span appears verbatim on a page of the same case."""

    def add(self, **fields: Any) -> M:
        page = DocumentPageRepository(self.session, self.org_id).get(fields["source_page_id"])
        if page is None:
            raise ProvenanceError("source page not found")
        doc = SourceDocumentRepository(self.session, self.org_id).get(page.document_id)
        if doc is None or doc.case_id != fields["case_id"]:
            raise ProvenanceError("source page belongs to a different case")
        span = fields["source_text_span"]
        if not span or not span.strip() or span not in page.ocr_text:
            raise ProvenanceError("source_text_span is not verbatim text from the source page")
        return super().add(**fields)

    def for_case(self, case_id: uuid.UUID) -> Sequence[M]:
        return self.list(self.model.case_id == case_id)


class TimelineEventRepository(ExtractedFactRepository[TimelineEvent]):
    model = TimelineEvent

    def for_case(self, case_id: uuid.UUID) -> Sequence[TimelineEvent]:
        """Dated events in date order, then undated ("Date unclear") events."""
        stmt = (
            self.select()
            .where(TimelineEvent.case_id == case_id)
            .order_by(TimelineEvent.event_date.asc().nulls_last(), TimelineEvent.created_at)
        )
        return self.session.scalars(stmt).all()


class PendingTestRepository(ExtractedFactRepository[PendingTest]):
    model = PendingTest


class DiscrepancyRepository(TenantRepository[Discrepancy]):
    model = Discrepancy

    def for_case(self, case_id: uuid.UUID) -> Sequence[Discrepancy]:
        return self.list(Discrepancy.case_id == case_id)
