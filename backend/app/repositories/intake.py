import uuid
from collections.abc import Sequence

from app.models import IntakeFact, IntakeSession, SessionTurn
from app.repositories.base import TenantRepository


class IntakeSessionRepository(TenantRepository[IntakeSession]):
    model = IntakeSession

    def for_case(self, case_id: uuid.UUID) -> Sequence[IntakeSession]:
        return self.list(IntakeSession.case_id == case_id, limit=1000)

    def latest_summarized(self, case_id: uuid.UUID) -> IntakeSession | None:
        stmt = (
            self.select()
            .where(IntakeSession.case_id == case_id, IntakeSession.status == "summarized")
            .order_by(IntakeSession.ended_at.desc().nulls_last(), IntakeSession.created_at.desc())
            .limit(1)
        )
        return self.session.scalar(stmt)


class SessionTurnRepository(TenantRepository[SessionTurn]):
    model = SessionTurn

    def for_session(self, session_id: uuid.UUID) -> Sequence[SessionTurn]:
        stmt = self.select().where(SessionTurn.session_id == session_id).order_by(SessionTurn.turn_index)
        return self.session.scalars(stmt).all()


class IntakeFactRepository(TenantRepository[IntakeFact]):
    model = IntakeFact

    def for_session(self, session_id: uuid.UUID) -> Sequence[IntakeFact]:
        return self.list(IntakeFact.session_id == session_id, limit=1000)
