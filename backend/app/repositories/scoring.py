import uuid
from collections.abc import Sequence

from app.models import AnswerKey, BriefItemMatch, FacultyReview, ReadinessBrief, RubricItem, Score
from app.repositories.base import TenantRepository


class AnswerKeyRepository(TenantRepository[AnswerKey]):
    model = AnswerKey

    def current_for_case(self, case_id: uuid.UUID) -> AnswerKey | None:
        """Highest-version final answer key for the case."""
        stmt = (
            self.select()
            .where(AnswerKey.case_id == case_id, AnswerKey.status == "final")
            .order_by(AnswerKey.version.desc())
            .limit(1)
        )
        return self.session.scalar(stmt)


class RubricItemRepository(TenantRepository[RubricItem]):
    model = RubricItem

    def for_answer_key(self, answer_key_id: uuid.UUID) -> Sequence[RubricItem]:
        stmt = self.select().where(RubricItem.answer_key_id == answer_key_id).order_by(RubricItem.position)
        return self.session.scalars(stmt).all()


class ReadinessBriefRepository(TenantRepository[ReadinessBrief]):
    model = ReadinessBrief

    def get_for(self, case_id: uuid.UUID, author_user_id: uuid.UUID) -> ReadinessBrief | None:
        return self.session.scalar(
            self.select().where(ReadinessBrief.case_id == case_id, ReadinessBrief.author_user_id == author_user_id)
        )

    def has_submitted(self, case_id: uuid.UUID, author_user_id: uuid.UUID) -> bool:
        brief = self.get_for(case_id, author_user_id)
        return brief is not None and brief.status != "draft"

    def submitted(self, author_user_id: uuid.UUID | None = None) -> Sequence[ReadinessBrief]:
        stmt = self.select().where(ReadinessBrief.status != "draft")
        if author_user_id is not None:
            stmt = stmt.where(ReadinessBrief.author_user_id == author_user_id)
        return self.session.scalars(stmt.order_by(ReadinessBrief.submitted_at, ReadinessBrief.id)).all()


class BriefItemMatchRepository(TenantRepository[BriefItemMatch]):
    model = BriefItemMatch

    def for_brief(self, brief_id: uuid.UUID) -> Sequence[BriefItemMatch]:
        return self.list(BriefItemMatch.brief_id == brief_id, limit=1000)

    def get_for(self, brief_id: uuid.UUID, rubric_item_id: uuid.UUID) -> BriefItemMatch | None:
        return self.session.scalar(
            self.select().where(BriefItemMatch.brief_id == brief_id, BriefItemMatch.rubric_item_id == rubric_item_id)
        )


class ScoreRepository(TenantRepository[Score]):
    model = Score

    def get_for(self, brief_id: uuid.UUID, answer_key_id: uuid.UUID, version: str) -> Score | None:
        return self.session.scalar(
            self.select().where(
                Score.brief_id == brief_id, Score.answer_key_id == answer_key_id, Score.scoring_version == version
            )
        )

    def for_brief(self, brief_id: uuid.UUID) -> Sequence[Score]:
        return self.list(Score.brief_id == brief_id)


class FacultyReviewRepository(TenantRepository[FacultyReview]):
    model = FacultyReview
