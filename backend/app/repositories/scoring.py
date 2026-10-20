import uuid
from collections.abc import Sequence

from app.models import AnswerKey, BriefItemMatch, FacultyReview, ReadinessBrief, RubricItem, Score
from app.repositories.base import TenantRepository


class AnswerKeyRepository(TenantRepository[AnswerKey]):
    model = AnswerKey


class RubricItemRepository(TenantRepository[RubricItem]):
    model = RubricItem

    def for_answer_key(self, answer_key_id: uuid.UUID) -> Sequence[RubricItem]:
        stmt = self.select().where(RubricItem.answer_key_id == answer_key_id).order_by(RubricItem.position)
        return self.session.scalars(stmt).all()


class ReadinessBriefRepository(TenantRepository[ReadinessBrief]):
    model = ReadinessBrief


class BriefItemMatchRepository(TenantRepository[BriefItemMatch]):
    model = BriefItemMatch

    def for_brief(self, brief_id: uuid.UUID) -> Sequence[BriefItemMatch]:
        return self.list(BriefItemMatch.brief_id == brief_id)


class ScoreRepository(TenantRepository[Score]):
    model = Score

    def for_brief(self, brief_id: uuid.UUID) -> Sequence[Score]:
        return self.list(Score.brief_id == brief_id)


class FacultyReviewRepository(TenantRepository[FacultyReview]):
    model = FacultyReview
