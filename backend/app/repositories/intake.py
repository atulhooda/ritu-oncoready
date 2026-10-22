import uuid
from collections.abc import Sequence

from app.models import IntakeFact, IntakeSession, PatientProfile, SessionTurn
from app.repositories.base import TenantRepository


class IntakeSessionRepository(TenantRepository[IntakeSession]):
    model = IntakeSession

    def for_case(self, case_id: uuid.UUID) -> Sequence[IntakeSession]:
        return self.list(IntakeSession.case_id == case_id, limit=1000)

    def summarized(self, case_id: uuid.UUID, kind: str | None = None) -> Sequence[IntakeSession]:
        """Every summarized conversation for the case (of one kind, or all), newest first."""
        stmt = self.select().where(IntakeSession.case_id == case_id, IntakeSession.status == "summarized")
        if kind is not None:
            stmt = stmt.where(IntakeSession.kind == kind)
        stmt = stmt.order_by(IntakeSession.ended_at.desc().nulls_last(), IntakeSession.created_at.desc())
        return self.session.scalars(stmt).all()

    def latest_summarized(self, case_id: uuid.UUID, kind: str | None = None) -> IntakeSession | None:
        sessions = self.summarized(case_id, kind=kind)
        return sessions[0] if sessions else None


class SessionTurnRepository(TenantRepository[SessionTurn]):
    model = SessionTurn

    def for_session(self, session_id: uuid.UUID) -> Sequence[SessionTurn]:
        stmt = self.select().where(SessionTurn.session_id == session_id).order_by(SessionTurn.turn_index)
        return self.session.scalars(stmt).all()


class IntakeFactRepository(TenantRepository[IntakeFact]):
    model = IntakeFact

    def for_session(self, session_id: uuid.UUID) -> Sequence[IntakeFact]:
        return self.list(IntakeFact.session_id == session_id, limit=1000)


class PatientProfileRepository(TenantRepository[PatientProfile]):
    model = PatientProfile

    def get_for(self, patient_user_id: uuid.UUID) -> PatientProfile | None:
        return self.session.scalar(self.select().where(PatientProfile.patient_user_id == patient_user_id))
