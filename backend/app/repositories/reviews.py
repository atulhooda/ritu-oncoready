import uuid
from collections.abc import Sequence

from app.models import CaseReview
from app.repositories.base import TenantRepository


class CaseReviewRepository(TenantRepository[CaseReview]):
    model = CaseReview

    def for_case(self, case_id: uuid.UUID) -> CaseReview | None:
        return self.session.scalar(self.select().where(CaseReview.case_id == case_id))

    def ensure(self, case_id: uuid.UUID) -> CaseReview:
        """The case's review, created (unassigned) the first time it is needed."""
        return self.for_case(case_id) or self.add(case_id=case_id, status="unassigned")

    def waiting(self) -> Sequence[CaseReview]:
        """Sent patients no junior has yet, oldest first."""
        return self.list(CaseReview.status == "unassigned", limit=1000)

    def for_junior(self, user_id: uuid.UUID) -> Sequence[CaseReview]:
        return self.list(CaseReview.junior_user_id == user_id, limit=1000)

    def for_senior(self, user_id: uuid.UUID) -> Sequence[CaseReview]:
        return self.list(CaseReview.senior_user_id == user_id, CaseReview.status == "with_senior", limit=1000)
