import uuid
from collections.abc import Sequence

from app.models import DocumentPage, PatientCase, SourceDocument
from app.repositories.base import TenantRepository


class CaseRepository(TenantRepository[PatientCase]):
    model = PatientCase


class SourceDocumentRepository(TenantRepository[SourceDocument]):
    model = SourceDocument

    def for_case(self, case_id: uuid.UUID) -> Sequence[SourceDocument]:
        return self.list(SourceDocument.case_id == case_id)


class DocumentPageRepository(TenantRepository[DocumentPage]):
    model = DocumentPage

    def for_document(self, document_id: uuid.UUID) -> Sequence[DocumentPage]:
        stmt = self.select().where(DocumentPage.document_id == document_id).order_by(DocumentPage.page_number)
        return self.session.scalars(stmt).all()
