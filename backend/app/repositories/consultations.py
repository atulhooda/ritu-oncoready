import uuid
from collections.abc import Sequence

from app.models import Consultation
from app.repositories.base import TenantRepository


class ConsultationRepository(TenantRepository[Consultation]):
    model = Consultation

    def for_case(self, case_id: uuid.UUID) -> Sequence[Consultation]:
        """Newest first."""
        stmt = self.select().where(Consultation.case_id == case_id).order_by(Consultation.created_at.desc())
        return self.session.scalars(stmt).all()

    def approved_for_case(self, case_id: uuid.UUID) -> Sequence[Consultation]:
        return [c for c in self.for_case(case_id) if c.status == "approved"]
