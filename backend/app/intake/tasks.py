import uuid

from app.db import SessionLocal
from app.intake.extraction import run_intake_extraction
from app.repositories.intake import IntakeSessionRepository
from app.worker import celery_app


@celery_app.task(name="intake.summarize_session")
def summarize_session_task(org_id: str, session_id: str) -> dict:
    org, sid = uuid.UUID(org_id), uuid.UUID(session_id)
    try:
        with SessionLocal() as db:
            result = run_intake_extraction(db, org, sid)
            db.commit()
            return result
    except Exception as e:
        with SessionLocal() as db:
            session = IntakeSessionRepository(db, org).get(sid)
            if session is not None:
                session.status, session.error = "failed", f"{type(e).__name__}: {e}"[:2000]
                db.commit()
        raise


def enqueue_summary(org_id: uuid.UUID, session_id: uuid.UUID) -> None:
    summarize_session_task.delay(str(org_id), str(session_id))
