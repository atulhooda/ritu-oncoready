import uuid
from collections.abc import Sequence

from app.models import DocumentPage, PatientCase, SourceDocument
from app.repositories.base import TenantRepository


class CaseRepository(TenantRepository[PatientCase]):
    model = PatientCase

    def training(self) -> Sequence[PatientCase]:
        return self.list(PatientCase.kind == "training", limit=1000)

    def for_patient(self, patient_user_id: uuid.UUID) -> PatientCase | None:
        return self.session.scalar(self.select().where(PatientCase.patient_user_id == patient_user_id))

    def published_intake(self) -> Sequence[PatientCase]:
        stmt = (
            self.select()
            .where(PatientCase.kind == "intake", PatientCase.published_at.is_not(None))
            .order_by(PatientCase.published_at.desc())
        )
        return self.session.scalars(stmt).all()

    def lock(self, case_id: uuid.UUID) -> PatientCase | None:
        """Row lock serializing per-case derived-data recomputation."""
        return self.session.scalar(self.select().where(PatientCase.id == case_id).with_for_update())


class SourceDocumentRepository(TenantRepository[SourceDocument]):
    model = SourceDocument

    def for_case(self, case_id: uuid.UUID) -> Sequence[SourceDocument]:
        return self.list(SourceDocument.case_id == case_id)


class DocumentPageRepository(TenantRepository[DocumentPage]):
    model = DocumentPage

    def for_document(self, document_id: uuid.UUID) -> Sequence[DocumentPage]:
        stmt = self.select().where(DocumentPage.document_id == document_id).order_by(DocumentPage.page_number)
        return self.session.scalars(stmt).all()

    def get_by_number(self, document_id: uuid.UUID, page_number: int) -> DocumentPage | None:
        return self.session.scalar(
            self.select().where(DocumentPage.document_id == document_id, DocumentPage.page_number == page_number)
        )

    def for_case(self, case_id: uuid.UUID) -> Sequence[DocumentPage]:
        stmt = (
            self.select()
            .join(SourceDocument, SourceDocument.id == DocumentPage.document_id)
            .where(SourceDocument.case_id == case_id, SourceDocument.org_id == self.org_id)
        )
        return self.session.scalars(stmt).all()
