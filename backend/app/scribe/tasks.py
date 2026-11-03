import uuid

from app.db import SessionLocal
from app.repositories.consultations import ConsultationRepository
from app.scribe.extraction import run_scribe
from app.worker import celery_app


@celery_app.task(name="scribe.process_consultation")
def process_consultation_task(org_id: str, consultation_id: str) -> dict:
    org, cid = uuid.UUID(org_id), uuid.UUID(consultation_id)
    try:
        with SessionLocal() as db:
            result = run_scribe(db, org, cid)
            db.commit()
            return result
    except Exception as e:
        with SessionLocal() as db:
            c = ConsultationRepository(db, org).get(cid)
            if c is not None:
                c.status, c.error = "failed", f"{e}"[:2000]
                db.commit()
        raise


def enqueue_consultation(org_id: uuid.UUID, consultation_id: uuid.UUID) -> None:
    process_consultation_task.delay(str(org_id), str(consultation_id))
