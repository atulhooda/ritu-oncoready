import uuid
from collections.abc import Sequence

from sqlalchemy import update

from app.models import PatientRequest
from app.repositories.base import TenantRepository


class PatientRequestRepository(TenantRepository[PatientRequest]):
    model = PatientRequest

    def for_case(self, case_id: uuid.UUID) -> Sequence[PatientRequest]:
        return self.list(PatientRequest.case_id == case_id, limit=500)

    def unlink_document(self, document_id: uuid.UUID) -> None:
        """The patient removed a record they had sent for a request: keep the request, drop the link."""
        self.session.execute(
            update(PatientRequest)
            .where(PatientRequest.org_id == self.org_id, PatientRequest.answer_document_id == document_id)
            .values(answer_document_id=None)
        )
